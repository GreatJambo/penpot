#!/bin/sh
# Drop to pwuser before the long-lived process. Root is only used to
# make the artifact directory writable, then this process is replaced.
set -eu
mkdir -p /opt/penpot-mcp-headless/artifacts
if [ "$(id -u)" = "0" ]; then
    chown pwuser:pwuser /opt/penpot-mcp-headless/artifacts
    exec setpriv --reuid=pwuser --regid=pwuser --init-groups --inh-caps=-all \
        node /opt/penpot-mcp-headless/keep-open.mjs
fi
exec node /opt/penpot-mcp-headless/keep-open.mjs
