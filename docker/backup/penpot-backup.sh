#!/usr/bin/env bash
# Consistent backup of a running Penpot stack.
#
# Takes a custom-format pg_dump through the live postgres container (no
# downtime) and a gzip tarball of the assets volume mounted read-only in a
# throwaway container. Does not stop, recreate, or pull images.
#
# Connection settings are read from the postgres container's own environment
# at run time. This script does not contain credentials and does not write
# them to filenames or the log.
#
# Defaults match this host: backups live on /mnt/sdg, a different disk from
# Docker. Override with:
#   BACKUP_ROOT, PENPOT_PG_CONTAINER, PENPOT_ASSETS_VOLUME, PENPOT_TAR_IMAGE,
#   PENPOT_KEEP_DAILY

set -euo pipefail
umask 077

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

BACKUP_ROOT="${BACKUP_ROOT:-/mnt/sdg/penpot-backups}"
DAILY_DIR="${BACKUP_ROOT}/daily"
LOG_FILE="${BACKUP_ROOT}/penpot-backup.log"
LOCK_FILE="${BACKUP_ROOT}/penpot-backup.lock"
PG_CONTAINER="${PENPOT_PG_CONTAINER:-penpot-penpot-postgres-1}"
ASSETS_VOLUME="${PENPOT_ASSETS_VOLUME:-penpot_penpot_assets}"
# Userspace for tar/gzip and pg_restore. Must already be local; --pull never.
TAR_IMAGE="${PENPOT_TAR_IMAGE:-postgres:15}"
KEEP_DAILY="${PENPOT_KEEP_DAILY:-3}"
LOG_CAP_BYTES=1048576
PARTIAL_MAX_AGE_MIN=120

start_ts=""
status="failed"
reason="unknown"
db_name="-"
assets_name="-"
db_bytes=0
assets_bytes=0
db_tmp=""
assets_tmp=""
logged=0
stamp=""

log_line() {
  local end_ts
  end_ts="$(date -Iseconds)"
  {
    printf '%s start=%s end=%s status=%s db=%s db_bytes=%s assets=%s assets_bytes=%s' \
      "$end_ts" "$start_ts" "$end_ts" "$status" \
      "$db_name" "$db_bytes" "$assets_name" "$assets_bytes"
    if [[ "$status" != "ok" && -n "$reason" ]]; then
      printf ' reason=%s' "$reason"
    fi
    printf '\n'
  } >> "$LOG_FILE"
}

cleanup_partials() {
  if [[ -n "$db_tmp" ]]; then
    rm -f -- "$db_tmp"
  fi
  if [[ -n "$assets_tmp" ]]; then
    rm -f -- "$assets_tmp"
  fi
}

# status=ok is set only on the normal success path, immediately before
# exit 0. A signal's EXIT trap can observe $?=0; that must not count as
# success or leave partial files behind.
finish() {
  local rc=$?
  trap - EXIT HUP INT TERM
  if [[ "$status" != "ok" ]]; then
    cleanup_partials
  fi
  if [[ "$logged" -eq 0 ]]; then
    logged=1
    log_line
  fi
  exit "$rc"
}

on_signal() {
  reason=signal
  exit "$1"
}

require_positive_int() {
  local value="$1"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    reason=bad_keep_count
    exit 1
  fi
}

cap_log() {
  local sz tmp
  [[ -f "$LOG_FILE" ]] || return 0
  sz="$(stat -c '%s' "$LOG_FILE")"
  if (( sz <= LOG_CAP_BYTES )); then
    return 0
  fi
  tmp="${LOG_FILE}.rotate"
  # Drop the first line: tail -c may begin mid-line.
  if ! tail -c "$LOG_CAP_BYTES" "$LOG_FILE" | sed '1d' > "$tmp"; then
    rm -f -- "$tmp"
    reason=log_rotate_failed
    exit 1
  fi
  mv -f "$tmp" "$LOG_FILE" || { reason=log_rotate_failed; exit 1; }
  chmod 600 "$LOG_FILE" || { reason=log_rotate_failed; exit 1; }
}

# Refuse to create a backup tree on the same filesystem as Docker data.
# /mnt/sdg must be a mount, and BACKUP_ROOT's parent must already exist and
# must not share a device id with the Docker root directory.
backup_disk_ok() {
  local parent docker_root parent_dev docker_dev
  mountpoint -q /mnt/sdg || return 1
  parent="$(dirname -- "$BACKUP_ROOT")"
  [[ -d "$parent" ]] || return 1
  docker_root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null)" || return 1
  [[ -n "$docker_root" && -e "$docker_root" ]] || return 1
  parent_dev="$(stat -c '%d' -- "$parent")" || return 1
  docker_dev="$(stat -c '%d' -- "$docker_root")" || return 1
  [[ "$parent_dev" != "$docker_dev" ]]
}

fail_backup_disk() {
  local now
  now="$(date -Iseconds)"
  printf '%s start=%s end=%s status=failed db=- db_bytes=0 assets=- assets_bytes=0 reason=backup_disk_missing\n' \
    "$now" "$now" "$now" >&2
  exit 1
}

remove_old_partials() {
  if [[ ! -d "$DAILY_DIR" ]]; then
    reason=prune_failed
    exit 1
  fi
  if ! find "$DAILY_DIR" -maxdepth 1 -type f -name '.penpot-*.partial' -mmin +${PARTIAL_MAX_AGE_MIN} -delete; then
    reason=prune_failed
    exit 1
  fi
}

remove_orphan_assets() {
  local dir="$1" base ts assets
  if [[ ! -d "$dir" ]]; then
    reason=prune_failed
    exit 1
  fi
  while IFS= read -r base; do
    [[ -n "$base" ]] || continue
    ts="${base#penpot-assets-}"
    ts="${ts%.tar.gz}"
    if [[ ! -f "${dir}/penpot-db-${ts}.dump" ]]; then
      assets="${dir}/${base}"
      rm -f -- "$assets" || { reason=prune_failed; exit 1; }
    fi
  done < <(find "$dir" -maxdepth 1 -type f -name 'penpot-assets-*.tar.gz' -printf '%f\n')
}

# Newest filename timestamp first. mtime is ignored. The stamp just written
# is never deleted, even when it is not among the newest names.
prune_dir() {
  local dir="$1" keep="$2" protected="$3"
  local -a stamps=()
  local i=0 ts dump assets
  require_positive_int "$keep"
  if [[ ! -d "$dir" ]]; then
    reason=prune_failed
    exit 1
  fi
  mapfile -t stamps < <(find "$dir" -maxdepth 1 -type f -name 'penpot-db-*.dump' -printf '%f\n' | LC_ALL=C sort -r | sed -E 's/^penpot-db-(.*)\.dump$/\1/')
  for ts in "${stamps[@]}"; do
    [[ -n "$ts" ]] || continue
    i=$((i + 1))
    if [[ -n "$protected" && "$ts" == "$protected" ]]; then
      continue
    fi
    if (( i > keep )); then
      dump="${dir}/penpot-db-${ts}.dump"
      assets="${dir}/penpot-assets-${ts}.tar.gz"
      if [[ -f "$dump" ]]; then
        rm -f -- "$dump" || { reason=prune_failed; exit 1; }
      fi
      if [[ -f "$assets" ]]; then
        rm -f -- "$assets" || { reason=prune_failed; exit 1; }
      fi
    fi
  done
  remove_orphan_assets "$dir"
}

main() {
  if ! backup_disk_ok; then
    fail_backup_disk
  fi

  mkdir -p "$DAILY_DIR"
  chmod 700 "$BACKUP_ROOT" "$DAILY_DIR"
  touch "$LOG_FILE" "$LOCK_FILE"
  chmod 600 "$LOG_FILE" "$LOCK_FILE"

  start_ts="$(date -Iseconds)"
  trap finish EXIT
  trap 'on_signal 129' HUP
  trap 'on_signal 130' INT
  trap 'on_signal 143' TERM
  cap_log

  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    reason=already_running
    exit 1
  fi

  require_positive_int "$KEEP_DAILY"
  remove_old_partials
  remove_orphan_assets "$DAILY_DIR"

  if ! command -v docker >/dev/null 2>&1; then
    reason=docker_missing
    exit 1
  fi

  if ! docker image inspect "$TAR_IMAGE" >/dev/null 2>&1; then
    reason=tar_image_not_local
    exit 1
  fi

  if ! docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null | grep -qx 'true'; then
    reason=postgres_container_not_running
    exit 1
  fi

  stamp="$(date +%Y%m%d-%H%M%S)"
  db_name="penpot-db-${stamp}.dump"
  assets_name="penpot-assets-${stamp}.tar.gz"
  db_tmp="${DAILY_DIR}/.${db_name}.partial"
  assets_tmp="${DAILY_DIR}/.${assets_name}.partial"
  rm -f -- "$db_tmp" "$assets_tmp"

  # pg_dump talks to the local socket inside the container. The username and
  # database name expand inside that container, not on the host. Do not pass
  # --file=- : pg_dump treats that as a literal filename, not stdout.
  if ! docker exec "$PG_CONTAINER" \
    sh -c 'pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --no-password' \
    > "$db_tmp"; then
    reason=pg_dump_failed
    exit 1
  fi

  db_bytes="$(stat -c '%s' "$db_tmp")"
  if [[ "$db_bytes" -le 0 ]]; then
    reason=empty_db_dump
    exit 1
  fi
  sig="$(head -c 5 "$db_tmp" || true)"
  if [[ "$sig" != "PGDMP" ]]; then
    reason=bad_db_dump_header
    exit 1
  fi

  # Read the whole custom archive. --file=/dev/null writes the generated
  # script to /dev/null and does not contact a database. The backup
  # directory is mounted read-only.
  if ! docker run --rm \
    --network none \
    --user "$(id -u):$(id -g)" \
    --entrypoint /usr/bin/pg_restore \
    --pull never \
    -v "${DAILY_DIR}:/backup:ro" \
    "$TAR_IMAGE" \
    --file=/dev/null "/backup/.${db_name}.partial"; then
    reason=bad_db_dump
    exit 1
  fi

  # Throwaway container, assets mounted read-only, no network. stdout is the
  # archive, so the file is created by this user rather than by root in the
  # container. The postgres image's entrypoint is replaced so it cannot start
  # a server. --pull never refuses to fetch TAR_IMAGE.
  if ! docker run --rm \
    --network none \
    --user 0:0 \
    --entrypoint tar \
    --pull never \
    -v "${ASSETS_VOLUME}:/assets:ro" \
    "$TAR_IMAGE" \
    -C /assets -czf - . \
    > "$assets_tmp"; then
    reason=assets_tar_failed
    exit 1
  fi

  chmod 600 "$db_tmp" "$assets_tmp"
  assets_bytes="$(stat -c '%s' "$assets_tmp")"
  if [[ "$assets_bytes" -le 0 ]]; then
    reason=empty_assets_archive
    exit 1
  fi
  if ! tar -tzf "$assets_tmp" >/dev/null; then
    reason=assets_archive_unreadable
    exit 1
  fi

  mv -f "$db_tmp" "${DAILY_DIR}/${db_name}"
  mv -f "$assets_tmp" "${DAILY_DIR}/${assets_name}"
  chmod 600 "${DAILY_DIR}/${db_name}" "${DAILY_DIR}/${assets_name}"
  db_tmp=""
  assets_tmp=""

  prune_dir "$DAILY_DIR" "$KEEP_DAILY" "$stamp"

  status=ok
  reason=
  exit 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
