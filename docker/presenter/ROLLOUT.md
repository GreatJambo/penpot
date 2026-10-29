# Live rollout

The presenter is a static sidecar. Penpot's backend, database, exporter, and MCP server stay on their current images. Nothing in this change migrates the database.

Every live `docker compose up` for this stack passes three compose files, in this order:

1. `~/penpot/docker-compose.yaml`
2. `~/penpot/mcp-headless/docker-compose.yaml`
3. `~/penpot/presenter/docker-compose.yaml`

Leaving out the MCP file drops the `/mcp-nav/stream` nginx mount. Leaving out the presenter file drops `/presenter/`.

## Services that change

- New container `penpot-presenter`, image `penpot-presenter:2.18.5`, built from `~/penpot/presenter` on the public `nginx:1.28-alpine` base. It is not published on a host port. It joins the compose network `penpot`.
- `penpot-frontend` is recreated so nginx loads one extra file, `nginx-presenter.conf`, at `/etc/nginx/overrides/server.d/presenter.conf`. The frontend image itself is unchanged. The MCP nav mount stays, because that compose file is still in the command.

Postgres, Valkey, the backend, the exporter, the MCP server, and the admin console are not recreated.

## Install the files

Do not point the compose file at a git checkout. Copy the directory from the merged fork commit into `~/penpot/presenter`.

```shell
mkdir -p "$HOME/penpot/presenter"
git -C /path/to/penpot-fork archive <merged-commit> docker/presenter \
  | tar -x -C "$HOME/penpot/presenter" --strip-components=2
```

`<merged-commit>` is the commit on `GreatJambo/penpot` that contains `docker/presenter`. After that, the live tree is `~/penpot/presenter` and it is not a checkout.

## Before changing the running stack

1. Take a fresh backup and confirm it finished.

```shell
/mnt/sdg/penpot-backups/bin/penpot-backup.sh
ls -lt /mnt/sdg/penpot-backups/daily | head
```

The newest database dump and assets tarball must both be from that run.

2. Tag the frontend image that is running now, so rollback does not depend on a floating tag:

```shell
docker tag "$(docker inspect -f '{{.Image}}' penpot-penpot-frontend-1)" penpotapp-running/frontend:2.18.5
```

## Apply

Do not edit `~/penpot/docker-compose.yaml`. `--pull never` belongs on `up`.

```shell
export PENPOT_PRESENTER_DIR="$HOME/penpot/presenter"

docker build -t penpot-presenter:2.18.5 "$PENPOT_PRESENTER_DIR"

docker compose -p penpot \
  -f "$HOME/penpot/docker-compose.yaml" \
  -f "$HOME/penpot/mcp-headless/docker-compose.yaml" \
  -f "$HOME/penpot/presenter/docker-compose.yaml" \
  up -d --pull never penpot-presenter

docker compose -p penpot \
  -f "$HOME/penpot/docker-compose.yaml" \
  -f "$HOME/penpot/mcp-headless/docker-compose.yaml" \
  -f "$HOME/penpot/presenter/docker-compose.yaml" \
  up -d --pull never --no-deps --force-recreate penpot-frontend
```

`--pull never` keeps the pinned Penpot images. The presenter image is the local tag, also with `pull_policy: never`.

Any later `up` of this project uses the same three `-f` arguments. A command that lists only `~/penpot/docker-compose.yaml` recreates the frontend without `/mcp-nav/stream` and without `/presenter/`.

## Downtime

Recreating the frontend takes a few seconds, and can take up to about 30 seconds. Designers lose the editor for that interval. Postgres, Valkey, the backend, the exporter, and `penpot-mcp` stay up. There is no schema migration. Files, sessions, and assets are unchanged.

After the frontend is back, `/presenter/` serves the page on the same host as Penpot. A Cloudflare Access policy on that host covers this path. No extra hostname is required. The page uses the existing `auth-token` cookie.

## Check

- `https://<your-penpot-host>/presenter/` shows the file picker when you are signed in, and a sign-in link when you are not.
- `/` still shows the Penpot login or dashboard.
- `/mcp/stream` still answers (401 or the MCP handshake, not 404).
- `/mcp-nav/stream` still reaches the headless sidecar.
- Opening a file in the normal viewer still renders.
- `docker inspect` shows `penpot-presenter` on the same network as `penpot-frontend`.

## Rollback

Recreate the frontend from the first two compose files only, then stop the sidecar. Do not use `down -v` on the Penpot project. The sidecar has no volume and holds no Penpot data. The MCP nav mount stays.

```shell
docker compose -p penpot \
  -f "$HOME/penpot/docker-compose.yaml" \
  -f "$HOME/penpot/mcp-headless/docker-compose.yaml" \
  up -d --pull never --no-deps --force-recreate penpot-frontend

docker stop penpot-penpot-presenter-1
docker rm penpot-penpot-presenter-1
```

If that recreate does not keep the image that was running before, start the tagged image. This override does not mount the presenter snippet. The MCP file is still listed, so `/mcp-nav/stream` stays.

```shell
docker compose -p penpot \
  -f "$HOME/penpot/docker-compose.yaml" \
  -f "$HOME/penpot/mcp-headless/docker-compose.yaml" \
  -f "$HOME/penpot/presenter/frontend-image-override.yaml" \
  up -d --pull never --no-deps --force-recreate penpot-frontend
```

`frontend-image-override.yaml` sets `image: penpotapp-running/frontend:2.18.5` and `pull_policy: never`. The editor, the exporter, and the design MCP are unchanged.
