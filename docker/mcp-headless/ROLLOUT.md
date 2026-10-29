# Live rollout

## Before changing the running stack

1. Take a fresh backup and confirm it finished:

```shell
/mnt/sdg/penpot-backups/bin/penpot-backup.sh
ls -lt /mnt/sdg/penpot-backups/daily | head
```

The newest database dump and assets tarball must both be from that run.

2. Tag the frontend image that is running now, so rollback does not depend on a floating tag:

```shell
docker tag "$(docker inspect -f '{{.Image}}' penpot-penpot-frontend-1)" penpotapp-running/frontend:2.18.5
```

## Secret file

Create `~/.config/penpot-mcp-headless.env`. The sidecar runs as `pwuser`
(uid 1001) and reads this file; it does not keep the password in the
process environment. It is not the Cloudflare Access env file. Do not
commit it and do not print it.

```shell
sudo chown 1001:1001 ~/.config/penpot-mcp-headless.env
chmod 400 ~/.config/penpot-mcp-headless.env
```

```
PENPOT_PUBLIC_URI=https://penpot.zhanchengbo.com
PENPOT_INTERNAL_ORIGIN=http://penpot-frontend:8080
PENPOT_EMAIL=you@example.com
PENPOT_PASSWORD=
PENPOT_MCP_USER_TOKEN=
```

`PENPOT_INTERNAL_ORIGIN` makes the headless browser open the public
origin while sending that traffic to the frontend container. Do not set
an Access service token.

## Apply

Do this from a checkout of `feat/mcp-headless`. Do not edit
`~/penpot/docker-compose.yaml`. The second compose file is the override.
`PENPOT_MCP_HEADLESS_DIR` is required: the image build context is that
directory, not the directory of the first compose file.

```shell
export PENPOT_MCP_HEADLESS_ENV_FILE=$HOME/.config/penpot-mcp-headless.env
export PENPOT_MCP_HEADLESS_DIR="$PWD/docker/mcp-headless"

docker build -t penpot-mcp-headless:2.18.5 "$PENPOT_MCP_HEADLESS_DIR"

docker compose -p penpot --pull never \
  -f "$HOME/penpot/docker-compose.yaml" \
  -f "$PENPOT_MCP_HEADLESS_DIR/docker-compose.yaml" \
  up -d penpot-mcp-headless

docker compose -p penpot --pull never \
  -f "$HOME/penpot/docker-compose.yaml" \
  -f "$PENPOT_MCP_HEADLESS_DIR/docker-compose.yaml" \
  up -d --no-deps --force-recreate penpot-frontend
```

The override adds service `penpot-mcp-headless` and one extra volume on
`penpot-frontend`, mounting `nginx-mcp-nav.conf` at
`/etc/nginx/overrides/server.d/mcp-nav.conf`. The 2.18.5 image already
includes that directory. `--pull never` keeps the pinned images.

`/mcp-nav/stream` uses `proxy_read_timeout 300s`. One nav call aborts
at 240s. That budget covers the task drain, the file open, one
re-login, and the retry, and it stays inside the proxy timeout.

The official `/mcp/ws` and `/mcp/stream` locations already log the
request line, including `userToken`, for a normal browser as well. A
mounted snippet cannot turn that log off without defining those
locations again, and nginx rejects a duplicate location. This change
does not redefine them. `/mcp-nav/stream` sets `access_log off` and
`error_log /dev/null emerg` so a 502 does not record the query string.

## Downtime

Recreating the frontend takes a few seconds, and can take up to about
30 seconds. Postgres, Valkey, the backend, the exporter, and
`penpot-mcp` stay up. The headless plugin reconnects after the frontend
is back. Design tools on `/mcp/stream` work again once that socket
returns.

## Check

`docker compose -p penpot logs penpot-mcp-headless` should show
`idle on dashboard`, and `docker inspect` should show the sidecar
healthcheck healthy after login. A call to
`https://penpot.zhanchengbo.com/mcp-nav/stream?userToken=...` with the
token from the secret file should list files. The same URL with no
token, or a different token, should return 401. `/mcp/stream` should
still answer.

## Rollback

Recreate the frontend from the original compose file only, then stop
the sidecar. Do not use `down -v` on the Penpot project. Removing the
sidecar artifact volume is optional and does not affect Penpot data.

```shell
docker compose -p penpot --pull never \
  -f "$HOME/penpot/docker-compose.yaml" \
  up -d --no-deps --force-recreate penpot-frontend

docker stop penpot-penpot-mcp-headless-1
docker rm penpot-penpot-mcp-headless-1
# Optional. Screenshots only. Penpot data is not in this volume.
# docker volume rm penpot_mcp_headless_artifacts
```

If the recreate does not keep the image that was running before, start
that container from `penpotapp-running/frontend:2.18.5` instead. The
nginx snippet is gone with the recreated frontend. The design MCP and
the rest of the stack are unchanged.
