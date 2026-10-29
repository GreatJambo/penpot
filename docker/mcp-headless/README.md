# Headless MCP sidecar

Penpot MCP tools that change a file run inside the MCP plugin. The
plugin runs in a browser tab that has a design file open. This sidecar
is that tab: headless Chromium logs in, opens one file, and lets the
bundled plugin connect.

It does not change the Penpot images. Add
`docker/mcp-headless/docker-compose.yaml` as a second compose file on
the existing project.

## Secret file

Copy `env.example` to a path outside this repo and `chmod 600` it. Put
the Penpot password only in that file. The live password is not stored
in the image or in git.

```shell
export PENPOT_MCP_HEADLESS_ENV_FILE=/path/to/secret.env
export PENPOT_MCP_HEADLESS_SCRIPT="$PWD/docker/mcp-headless/keep-open.mjs"
docker compose -p penpot \
  -f /path/to/penpot/docker-compose.yaml \
  -f docker/mcp-headless/docker-compose.yaml \
  up -d penpot-mcp-headless
```

Build the sidecar image once. It is a thin layer on the public
Playwright image and does not rebuild Penpot:

```shell
docker build -t penpot-mcp-headless:2.18.5 docker/mcp-headless
```

`PENPOT_PUBLIC_URI` must be a URL the sidecar container can open. On a
compose network that is `http://penpot-frontend:8080`. Use the public
HTTPS URL when the container reaches Penpot through the public site.
If that site is behind Cloudflare Access, set `CF_ACCESS_CLIENT_ID` and
`CF_ACCESS_CLIENT_SECRET` in the same secret file.

## What it keeps open

One team and one file, from `PENPOT_TEAM_ID` and `PENPOT_FILE_ID`. The
plugin serves that file, including its pages. It does not serve other
files until the container is recreated with a new file id.

The account is the email in the secret file. Create no user for this.
Only one plugin connection is allowed for that account's MCP token. A
normal browser with MCP connected will clash with the sidecar.

## Check

`docker compose logs penpot-mcp-headless` prints `plugin connected`
when the websocket is up. Status and screenshots are in the
`mcp_headless_artifacts` volume (`status.json`, `connected.png`).
Logs do not include the password or the MCP token.
