# Nightly backup for the self-hosted Penpot on this machine

The live stack is the Docker Compose project `penpot`
(`/home/jambo/penpot/docker-compose.yaml`). These notes match that
install. They do not change it.

The images running today are Penpot 2.18.3, commit `ff7a66f5`.
Docker Hub's floating tag `penpotapp/*:2.18` now points at 2.18.5,
which applies database migrations 0154–0156. Do not `docker pull` or
`docker compose pull` any `penpotapp` `:2.18` tag. A restore must
start the image IDs already loaded locally (retag them, for example
`penpot-pinned/backend:2.18.3`) and set `pull_policy: never`.

## Where backups live

| Path | Contents |
| --- | --- |
| `/home/jambo/penpot-backups/bin/penpot-backup.sh` | The script in this directory |
| `/home/jambo/penpot-backups/daily/` | Timestamped dump and assets archive |
| `/home/jambo/penpot-backups/weekly/` | Sunday copies (hard links) |
| `/home/jambo/penpot-backups/penpot-backup.log` | One line per run |
| `/home/jambo/penpot-backups/penpot-backup.lock` | `flock` lock |

File names:

- `penpot-db-YYYYmmdd-HHMMSS.dump` — `pg_dump` custom format (`PGDMP`)
- `penpot-assets-YYYYmmdd-HHMMSS.tar.gz` — assets volume

Directories are mode `0700`, backup files and the log are mode `0600`.

## Schedule

The machine timezone is `America/Chicago`. The user crontab sets
`CRON_TZ=America/Chicago`, and the job is:

```cron
0 3 * * * /home/jambo/penpot-backups/bin/penpot-backup.sh
```

That is 03:00 local time. The script logs start time, end time, file
sizes, and success or failure. A failed run exits non-zero.

## Retention

- 7 daily pairs in `daily/`
- 4 weekly pairs in `weekly/`

A weekly copy is made when the run's local weekday is Sunday. Daily
pruning removes only the daily names; the weekly hard links stay
until the weekly retention drops them. Pairs are ordered by the
timestamp in the filename (`LC_ALL=C`), not by file mtime. Keep
counts must be positive integers. The pair just written is never
deleted. An assets archive with no matching dump is removed.

## What one run does

1. Takes an exclusive lock. A second run logs `error=already_running`
   and exits 1.
2. Runs `pg_dump --format=custom` inside the live Postgres container
   (`penpot-penpot-postgres-1` by default). The user and database
   come from that container's environment. Nothing is stopped.
   Do not pass `pg_dump --file=-`; that writes a file named `-`
   instead of stdout.
3. Tars the assets volume `penpot_penpot_assets` from a throwaway
   container with the volume mounted read-only, `--network none`,
   and `--pull never`. The archive is the container's stdout.
4. Rejects an empty file, a dump that does not start with `PGDMP`,
   a dump that `pg_restore --file=/dev/null` cannot read (throwaway
   container, `--network none`, `--pull never`, backup directory
   mounted read-only), or a tarball `tar` cannot list.
5. Publishes the files, then applies retention. `SIGHUP`, `SIGINT`,
   and `SIGTERM` log `status=failed` `reason=signal` and delete
   partial files. Partial files older than 120 minutes, and assets
   archives with no matching dump, are removed at the start of a
   run. The log is capped at about 1 MiB.

Overrides: `BACKUP_ROOT`, `PENPOT_PG_CONTAINER`, `PENPOT_ASSETS_VOLUME`,
`PENPOT_TAR_IMAGE`, `PENPOT_KEEP_DAILY`, `PENPOT_KEEP_WEEKLY`.

## Restore onto a throwaway stack

**Never run a restore against `/home/jambo/penpot/docker-compose.yaml`.**
That file publishes `9001:8080` and is the live Compose project
`penpot`. `docker compose down -v` with no `-p` and no `-f`, or any
command whose working directory or `-f` is `~/penpot`, selects that
project and deletes `penpot_penpot_postgres_v15` and
`penpot_penpot_assets`. Do not copy that file. Do not `cd ~/penpot`
for these commands.

Use only `/home/jambo/penpot-restore/` and this file,
`docker/backup/docker-compose.restore.yaml`. Every command below
passes `-p penpot-restore -f /home/jambo/penpot-restore/docker-compose.yaml`.
The file sets `name: penpot-restore`, `pull_policy: never`, and
`127.0.0.1:9101:8080`. Its volume names are `penpot-restore_postgres_v15`
and `penpot-restore_assets`. It does not define `penpot-admin-console`
or `penpot-mcp`. The app `up` still passes `--no-deps` so those
services are not started.

Images, already loaded locally (do not pull):

- `penpot-pinned/postgres:15`
- `penpot-pinned/valkey:8.1`
- `penpot-pinned/backend:2.18.3`
- `penpot-pinned/exporter:2.18.3`
- `penpot-pinned/frontend:2.18.3`

```bash
mkdir -p /home/jambo/penpot-restore
cp docker/backup/docker-compose.restore.yaml \
  /home/jambo/penpot-restore/docker-compose.yaml
chmod 700 /home/jambo/penpot-restore
chmod 600 /home/jambo/penpot-restore/docker-compose.yaml
# Throwaway values for this shell only. Do not write them down.
export PENPOT_RESTORE_PASSWORD="$(openssl rand -hex 16)"
export PENPOT_RESTORE_SECRET="$(openssl rand -hex 32)"

docker compose -p penpot-restore \
  -f /home/jambo/penpot-restore/docker-compose.yaml \
  up -d --pull never --no-build penpot-postgres penpot-valkey

docker volume create penpot-restore_assets
docker run -i --rm --network none --user 0:0 --entrypoint tar \
  --pull never \
  -v penpot-restore_assets:/assets \
  penpot-pinned/postgres:15 \
  -C /assets -xzf - < /home/jambo/penpot-backups/daily/penpot-assets-STAMP.tar.gz

# POSTGRES_USER is the superuser; there is no role named postgres.
# The password is expanded inside the container.
docker exec -u postgres -i penpot-restore-penpot-postgres-1 \
  sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_restore -h 127.0.0.1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --no-password --exit-on-error --no-privileges --single-transaction' \
  < /home/jambo/penpot-backups/daily/penpot-db-STAMP.dump

# --no-deps: do not start penpot-admin-console, penpot-mcp, or any
# other service this command did not name.
docker compose -p penpot-restore \
  -f /home/jambo/penpot-restore/docker-compose.yaml \
  up -d --pull never --no-build --no-deps \
  penpot-backend penpot-exporter penpot-frontend
```

Confirm the backend log has no `apply migration`. On 2.18.3 the newest
`migrations.step` is `0153-del-orphan-profile-rels-after-team-leave`.
`http://127.0.0.1:9101/` is the login page and
`http://127.0.0.1:9101/readyz` returns `OK`. Compare `count(*)` on
`file` and `project` with the live database using `SELECT` only.

Tear the throwaway project down with the same `-p` and `-f`, then
check the live volumes and the live project:

```bash
docker compose -p penpot-restore \
  -f /home/jambo/penpot-restore/docker-compose.yaml \
  down -v --remove-orphans

docker volume ls | grep penpot_penpot_
docker compose ls
```

`grep` must still list `penpot_penpot_assets` and
`penpot_penpot_postgres_v15`. `docker compose ls` must show `penpot`
as `running(8)`. `penpot-restore_postgres_v15` and
`penpot-restore_assets` must be gone (`docker volume rm` them if
`down -v` left either one). Unset `PENPOT_RESTORE_PASSWORD` and
`PENPOT_RESTORE_SECRET`.

The backup script never prints or stores the database password. Do
not copy `~/penpot/.env` into a backup filename, a log line, or a
commit.
