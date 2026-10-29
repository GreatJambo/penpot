# Live rollout

This turns on the headless sidecar for the running Penpot stack without
rebuilding an official image and without changing Cloudflare Tunnel or
Access. Access already covers the public hostname, so `/mcp-nav/stream`
is behind it the same way `/mcp/stream` is.

Do this from a checkout of `feat/mcp-headless`. Do not edit
`~/penpot/docker-compose.yaml`. The second compose file is the override.

## Secret file

Create `~/.config/penpot-mcp-headless.env` and `chmod 600` it. It holds
the password for `Chamberlainzhan@gmail.com` and that account's existing
MCP `userToken`. It is not the Cloudflare Access env file. Do not commit
it and do not print it.

```
PENPOT_PUBLIC_URI=https://penpot.zhanchengbo.com
PENPOT_INTERNAL_ORIGIN=http://penpot-frontend:8080
PENPOT_EMAIL=Chamberlainzhan@gmail.com
PENPOT_PASSWORD=
PENPOT_MCP_USER_TOKEN=
```

`PENPOT_INTERNAL_ORIGIN` makes the headless browser open the public
origin while sending that traffic to the frontend container. Leave the
Access service-token variables unset.

## Apply

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

The override adds two things:

- service `penpot-mcp-headless`
- one extra volume on `penpot-frontend`, mounting
  `nginx-mcp-nav.conf` at
  `/etc/nginx/overrides/server.d/mcp-nav.conf`

The 2.18.5 frontend image already includes that directory. The mount
does not change the image. `--pull never` keeps the pinned images.

## Downtime

Only the frontend container is recreated. Postgres, Valkey, the
backend, the exporter, and `penpot-mcp` stay up. The site is briefly
unavailable while the frontend nginx restarts. The headless plugin
reconnects after the frontend is back. Design tools on `/mcp/stream`
keep working once that socket returns.

## Check

`docker compose -p penpot logs penpot-mcp-headless` should show
`idle on dashboard`. A call to
`https://penpot.zhanchengbo.com/mcp-nav/stream?userToken=...` with the
token from the secret file should list files. The same URL with no
token, or a different token, should return 401. `/mcp/stream` should
still answer.

## Rollback

Recreate the frontend from the original compose file only, then stop
the sidecar. Do not use `down -v`.

```shell
docker compose -p penpot --pull never \
  -f "$HOME/penpot/docker-compose.yaml" \
  up -d --no-deps --force-recreate penpot-frontend

docker stop penpot-penpot-mcp-headless-1
docker rm penpot-penpot-mcp-headless-1
```

The nginx snippet is gone with the recreated frontend. The design MCP
and the rest of the stack are unchanged. A normal browser can connect
the plugin again.
