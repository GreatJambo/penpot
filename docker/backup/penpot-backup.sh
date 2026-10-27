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
# Defaults match the penpot compose project on this host. Override with:
#   BACKUP_ROOT, PENPOT_PG_CONTAINER, PENPOT_ASSETS_VOLUME, PENPOT_TAR_IMAGE,
#   PENPOT_KEEP_DAILY, PENPOT_KEEP_WEEKLY

set -euo pipefail
umask 077

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

BACKUP_ROOT="${BACKUP_ROOT:-${HOME}/penpot-backups}"
DAILY_DIR="${BACKUP_ROOT}/daily"
WEEKLY_DIR="${BACKUP_ROOT}/weekly"
LOG_FILE="${BACKUP_ROOT}/penpot-backup.log"
LOCK_FILE="${BACKUP_ROOT}/penpot-backup.lock"
PG_CONTAINER="${PENPOT_PG_CONTAINER:-penpot-penpot-postgres-1}"
ASSETS_VOLUME="${PENPOT_ASSETS_VOLUME:-penpot_penpot_assets}"
# Userspace for tar/gzip only. Must already be local; --pull never is set.
TAR_IMAGE="${PENPOT_TAR_IMAGE:-postgres:15}"
KEEP_DAILY="${PENPOT_KEEP_DAILY:-7}"
KEEP_WEEKLY="${PENPOT_KEEP_WEEKLY:-4}"

mkdir -p "$DAILY_DIR" "$WEEKLY_DIR"
chmod 700 "$BACKUP_ROOT" "$DAILY_DIR" "$WEEKLY_DIR"
touch "$LOG_FILE"
chmod 600 "$LOG_FILE" "$LOCK_FILE" 2>/dev/null || true
touch "$LOCK_FILE"
chmod 600 "$LOCK_FILE"

start_ts="$(date -Iseconds)"
status="fail"
reason="unknown"
db_name="-"
assets_name="-"
db_bytes=0
assets_bytes=0
db_tmp=""
assets_tmp=""
logged=0

log_line() {
  local end_ts
  end_ts="$(date -Iseconds)"
  {
    printf '%s start=%s end=%s status=%s db=%s db_bytes=%s assets=%s assets_bytes=%s' \
      "$end_ts" "$start_ts" "$end_ts" "$status" \
      "$db_name" "$db_bytes" "$assets_name" "$assets_bytes"
    if [[ "$status" != "ok" && -n "$reason" ]]; then
      printf ' error=%s' "$reason"
    fi
    printf '\n'
  } >> "$LOG_FILE"
}

cleanup_partials() {
  if [[ -n "$db_tmp" ]]; then
    rm -f "$db_tmp"
  fi
  if [[ -n "$assets_tmp" ]]; then
    rm -f "$assets_tmp"
  fi
}

finish() {
  local rc=$?
  trap - EXIT
  if [[ "$rc" -eq 0 ]]; then
    status="ok"
    reason=""
  else
    cleanup_partials
  fi
  if [[ "$logged" -eq 0 ]]; then
    logged=1
    log_line
  fi
  exit "$rc"
}
trap finish EXIT

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  reason="already_running"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  reason="docker_missing"
  exit 1
fi

if ! docker image inspect "$TAR_IMAGE" >/dev/null 2>&1; then
  reason="tar_image_not_local"
  exit 1
fi

if ! docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null | grep -qx 'true'; then
  reason="postgres_container_not_running"
  exit 1
fi

stamp="$(date +%Y%m%d-%H%M%S)"
db_name="penpot-db-${stamp}.dump"
assets_name="penpot-assets-${stamp}.tar.gz"
db_tmp="${DAILY_DIR}/.${db_name}.partial"
assets_tmp="${DAILY_DIR}/.${assets_name}.partial"
rm -f "$db_tmp" "$assets_tmp"

# pg_dump talks to the local socket inside the container. The username and
# database name expand inside that container, not on the host. Do not pass
# --file=- : pg_dump treats that as a literal filename, not stdout.
if ! docker exec "$PG_CONTAINER" \
  sh -c 'pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --no-password' \
  > "$db_tmp"; then
  reason="pg_dump_failed"
  exit 1
fi

db_bytes="$(stat -c '%s' "$db_tmp")"
if [[ "$db_bytes" -le 0 ]]; then
  reason="empty_db_dump"
  exit 1
fi
sig="$(head -c 5 "$db_tmp" || true)"
if [[ "$sig" != "PGDMP" ]]; then
  reason="bad_db_dump_header"
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
  reason="assets_tar_failed"
  exit 1
fi

chmod 600 "$db_tmp" "$assets_tmp"
assets_bytes="$(stat -c '%s' "$assets_tmp")"
if [[ "$assets_bytes" -le 0 ]]; then
  reason="empty_assets_archive"
  exit 1
fi
if ! tar -tzf "$assets_tmp" >/dev/null; then
  reason="assets_archive_unreadable"
  exit 1
fi

mv -f "$db_tmp" "${DAILY_DIR}/${db_name}"
mv -f "$assets_tmp" "${DAILY_DIR}/${assets_name}"
chmod 600 "${DAILY_DIR}/${db_name}" "${DAILY_DIR}/${assets_name}"
db_tmp=""
assets_tmp=""

# Sunday in the machine's local timezone. Hard links: deleting a daily name
# later does not remove the weekly copy.
if [[ "$(date +%u)" -eq 7 ]]; then
  ln -f "${DAILY_DIR}/${db_name}" "${WEEKLY_DIR}/${db_name}"
  ln -f "${DAILY_DIR}/${assets_name}" "${WEEKLY_DIR}/${assets_name}"
fi

prune_dir() {
  local dir="$1"
  local keep="$2"
  local name ts i
  local -a names=()
  mapfile -t names < <(find "$dir" -maxdepth 1 -type f -name 'penpot-db-*.dump' -printf '%T@ %f\n' | sort -nr | awk '{print $2}')
  i=0
  for name in "${names[@]}"; do
    i=$((i + 1))
    if (( i > keep )); then
      ts="${name#penpot-db-}"
      ts="${ts%.dump}"
      rm -f "${dir}/penpot-db-${ts}.dump" "${dir}/penpot-assets-${ts}.tar.gz"
    fi
  done
}

if ! prune_dir "$DAILY_DIR" "$KEEP_DAILY"; then
  reason="prune_daily_failed"
  exit 1
fi
if ! prune_dir "$WEEKLY_DIR" "$KEEP_WEEKLY"; then
  reason="prune_weekly_failed"
  exit 1
fi

exit 0
