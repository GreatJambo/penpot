# Live rollout

The presenter is a static sidecar. Penpot's backend, database, exporter, and MCP server stay on their current images. Nothing in this change migrates the database.

## Services that change

- New container `penpot-presenter`, image `penpot-presenter:2.18.5`, built from `docker/presenter` on the public `nginx:1.27-alpine` base. It is not published on a host port.
- `penpot-frontend` is recreated so nginx loads one extra file, `nginx-presenter.conf`, at `/etc/nginx/overrides/server.d/presenter.conf`. The frontend image itself is unchanged.

Postgres, Valkey, the backend, the exporter, the MCP server, and the admin console are not recreated.

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

Do this from a checkout of `feat/presenter-view`. Do not edit `~/penpot/docker-compose.yaml`. The second compose file is the override.

```shell
export PENPOT_PRESENTER_DIR="$PWD/docker/presenter"

docker build -t penpot-presenter:2.18.5 "$PENPOT_PRESENTER_DIR"

docker compose -p penpot --pull never \
  -f "$HOME/penpot/docker-compose.yaml" \
  -f "$PENPOT_PRESENTER_DIR/docker-compose.yaml" \
  up -d penpot-presenter

docker compose -p penpot --pull never \
  -f "$HOME/penpot/docker-compose.yaml" \
  -f "$PENPOT_PRESENTER_DIR/docker-compose.yaml" \
  up -d --no-deps --force-recreate penpot-frontend
```

`--pull never` keeps the pinned Penpot images. The presenter image is the local tag, also with `pull_policy: never`.

## Downtime

Recreating the frontend takes a few seconds, and can take up to about 30 seconds. Designers lose the editor for that interval. Postgres, Valkey, the backend, the exporter, and `penpot-mcp` stay up. There is no schema migration. Files, sessions, and assets are unchanged.

After the frontend is back, `/presenter/` serves the page on the same host as Penpot. A Cloudflare Access policy on that host covers this path. No extra hostname is required. The page uses the existing `auth-token` cookie.

## Check

- `https://<your-penpot-host>/presenter/` shows the file picker when you are signed in, and a sign-in link when you are not.
- `/` still shows the Penpot login or dashboard.
- `/mcp/stream` still answers (401 or the MCP handshake, not 404).
- Opening a file in the normal viewer still renders.

## Rollback

Recreate the frontend from the original compose file only, then stop the sidecar. Do not use `down -v` on the Penpot project. The sidecar has no volume and holds no Penpot data.

```shell
docker compose -p penpot --pull never \
  -f "$HOME/penpot/docker-compose.yaml" \
  up -d --no-deps --force-recreate penpot-frontend

docker stop penpot-penpot-presenter-1
docker rm penpot-penpot-presenter-1
```

If the recreate does not keep the image that was running before, start that container from `penpotapp-running/frontend:2.18.5` instead. The nginx snippet is gone with the recreated frontend. The editor, the exporter, and the design MCP are unchanged.
