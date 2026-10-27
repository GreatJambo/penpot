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
until the weekly retention drops them.

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
   or a tarball `tar` cannot list.
5. Publishes the files, then applies retention.

Overrides: `BACKUP_ROOT`, `PENPOT_PG_CONTAINER`, `PENPOT_ASSETS_VOLUME`,
`PENPOT_TAR_IMAGE`, `PENPOT_KEEP_DAILY`, `PENPOT_KEEP_WEEKLY`.

## Restore onto a throwaway stack

Use a different Compose project and new volumes. Do not mount
`penpot_penpot_postgres_v15` or `penpot_penpot_assets`.

1. Retag the image IDs that the live containers are running, for
   example `penpot-pinned/backend:2.18.3`,
   `penpot-pinned/frontend:2.18.3`,
   `penpot-pinned/exporter:2.18.3`, plus the local `postgres:15` and
   Valkey images. Confirm each tag's ID equals the running
   container's image. Do not start `penpot-local/*` builds and do
   not pull.
2. Bring up only Postgres and Valkey (`pull_policy: never`,
   `--pull never`, `--no-build`) on the new project. Publish the
   frontend on a free port such as `127.0.0.1:9101:8080` only after
   the data is restored.
3. Restore the assets archive into the new volume before the backend
   starts. `docker run` must be given `-i` so `tar` can read stdin:

   ```bash
   docker run -i --rm --network none --user 0:0 --entrypoint tar \
     --pull never \
     -v NEW_ASSETS_VOLUME:/assets \
     penpot-pinned/postgres:15 \
     -C /assets -xzf - < penpot-assets-STAMP.tar.gz
   ```

4. Restore the dump before the Penpot backend starts. When
   `POSTGRES_USER` is set, the official Postgres image does not
   create a role named `postgres`; that user is the superuser.
   Connect as that user over `127.0.0.1` and take the password from
   the container environment (do not put it on the host command
   line):

   ```bash
   docker exec -u postgres -i NEW_POSTGRES_CONTAINER \
     sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_restore -h 127.0.0.1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --no-password --exit-on-error --no-privileges --single-transaction' \
     < penpot-db-STAMP.dump
   ```

5. Start backend, exporter, and frontend from the pinned 2.18.3
   images. The backend log should contain `running migrations` and
   must not contain `apply migration`. The newest `migrations.step`
   on a 2.18.3 database is `0153-del-orphan-profile-rels-after-team-leave`.
   Seeing 0154 or later means a newer image ran.
6. Check `http://127.0.0.1:9101/` (login page) and
   `http://127.0.0.1:9101/readyz` (body `OK`). Compare
   `count(*)` from `file` and `project` with the live database.
   Use `SELECT` only on the live database.
7. Remove the throwaway project with `docker compose down -v` and
   confirm the live project `penpot` is still `running(8)`.

The script never prints or stores the database password. Do not copy
`~/penpot/.env` into a backup filename, a log line, or a commit.
