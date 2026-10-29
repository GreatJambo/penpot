# Headless MCP sidecar

Penpot MCP tools that change a file run inside the MCP plugin. The
plugin runs in a browser tab that has a design file open. This sidecar
is that tab.

It does not change the Penpot images. The sidecar does not pin a file.
It signs in and sits on the dashboard until an agent opens a file.

## Two MCP endpoints

Design tools (`execute_code`, `export_shape`, and the rest) stay on the
Penpot MCP server, at the existing `/mcp/stream` path.

File choice is a second, small MCP server in this container:

- Compose network: `http://penpot-mcp-headless:4410/mcp`
- This machine only: `http://127.0.0.1:4410/mcp`

Port 4410 is published on `127.0.0.1`. Do not add it to Cloudflare.
Agents on this machine call it directly. Tools:

- `list_files` lists teams, projects, and files for the logged-in session.
- `open_file` opens one file and waits until the plugin reconnects.
- `current_file` reports the file that is open now.

`open_file` takes `fileId`, or `name` plus an optional `projectId`, and
an optional `pageId`. Switches wait until the plugin has no task in
flight, then run one at a time. A design-tool call that starts during
the navigation itself can fail; retry it.

The official plugin can change pages in the open file (`penpot.openPage`).
It cannot open a different file.

## What stays open

After `open_file`, that file stays open until the next `open_file` or
until the container restarts. A restart returns to the dashboard, so
config never pins a file. Keeping the last file avoids loading the
workspace again for every design-tool call.

## Secret file and local routing

Copy `env.example` outside this repo and `chmod 600` it. The password
goes only in that file.

```shell
export PENPOT_MCP_HEADLESS_ENV_FILE=/path/to/secret.env
export PENPOT_MCP_HEADLESS_DIR="$PWD/docker/mcp-headless"
docker build -t penpot-mcp-headless:2.18.5 docker/mcp-headless
docker compose -p penpot \
  -f /path/to/penpot/docker-compose.yaml \
  -f docker/mcp-headless/docker-compose.yaml \
  up -d penpot-mcp-headless
```

Set `PENPOT_PUBLIC_URI` to the origin the editor is configured with.
Set `PENPOT_INTERNAL_ORIGIN` to `http://penpot-frontend:8080` when that
origin is the public site. Chromium then resolves the public host to
`127.0.0.1`, and a proxy inside this container forwards HTTP and
WebSockets (`/mcp/ws`, `/ws/notifications`) to the frontend. Other host
names do not resolve. Cloudflare is not on that path.

`CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` are only for the
case where the browser must open the public site itself. Leave them
unset when internal routing is on.

## Check

`docker compose logs penpot-mcp-headless` prints `idle on dashboard`,
then `plugin connected` after `open_file`. Status and screenshots are
in the `mcp_headless_artifacts` volume. Logs do not include the password
or the MCP token.
