#!/usr/bin/env bash
# Build local Penpot images from this checkout.
#
# Official Dockerfiles (docker/images/Dockerfile.*) pull base images from
# dhi.io, which requires `docker login dhi.io` (a free Docker Hub account;
# anonymous pulls return 401). Pass --public-bases to rewrite those FROM
# lines in a temporary build context onto public Debian/Node/Nginx images.
# That path is for a local rehearsal only: the resulting images are not
# bit-identical to penpotapp/*.
#
# This script never pushes, and it refuses the penpotapp namespace so a
# local build cannot clobber the official tags in the local image store
# by name (docker still keeps them as separate repos only if the name
# differs).
#
# Bundles are compiled inside the public penpotapp/devenv image, same
# entrypoint as ./manage.sh build-<module>-bundle, with a CPU cap so a
# shared machine is not saturated. No GPUs are requested; the runtime is
# runc.

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

PREFIX=${PENPOT_IMAGE_PREFIX:-penpot-local}
TAG=${PENPOT_IMAGE_TAG:-}
CPUS=${PENPOT_BUILD_CPUS:-12}
MEMORY=${PENPOT_BUILD_MEMORY:-32g}
PUBLIC_BASES=0
SKIP_BUNDLES=0
MODULES=(backend exporter mcp frontend)

usage() {
    cat <<'EOF'
Usage: scripts/build-selfhost-images.sh [options]

  --prefix NAME     Image namespace (default: penpot-local). penpotapp is refused.
  --tag TAG         Image tag (default: git describe --tags --match '*.*.*').
  --public-bases    Build FROM public Debian/Node/Nginx images instead of dhi.io.
  --skip-bundles    Package images from existing module build output.
  --cpus N          CPU cap for bundle containers (default: 12).
  --memory SIZE     Memory cap for bundle containers (default: 32g).

Environment overrides: PENPOT_IMAGE_PREFIX, PENPOT_IMAGE_TAG,
PENPOT_BUILD_CPUS, PENPOT_BUILD_MEMORY.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --prefix) PREFIX=$2; shift 2 ;;
        --tag) TAG=$2; shift 2 ;;
        --public-bases) PUBLIC_BASES=1; shift ;;
        --skip-bundles) SKIP_BUNDLES=1; shift ;;
        --cpus) CPUS=$2; shift 2 ;;
        --memory) MEMORY=$2; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
done

if [[ "$PREFIX" == "penpotapp" || "$PREFIX" == "docker.io/penpotapp" ]]; then
    echo "refusing prefix '$PREFIX'; pick a local namespace such as penpot-local" >&2
    exit 1
fi

if [[ -z "$TAG" ]]; then
    TAG=$(git describe --tags --match '*.*.*' --dirty --always)
fi

echo "prefix=$PREFIX tag=$TAG public_bases=$PUBLIC_BASES skip_bundles=$SKIP_BUNDLES cpus=$CPUS memory=$MEMORY"
echo "HEAD=$(git rev-parse HEAD) describe=$(git describe --tags --match '*.*.*' --dirty --always)"

put_license() {
    local target=$1
    cat >> "$target/LICENSE" <<'EOF'
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at http://mozilla.org/MPL/2.0/.

Copyright (c) KALEIDOS INC Sucursal en España SL
EOF
}

build_bundle() {
    local mod=$1
    echo "===== bundle $mod $(date -Is) ====="
    docker volume create penpot_rehearsal_build_home >/dev/null
    docker run -t --rm \
        --runtime=runc \
        --cpus="$CPUS" \
        --memory="$MEMORY" \
        --pids-limit=4096 \
        --name "penpot-selfhost-build-${mod}" \
        --mount source=penpot_rehearsal_build_home,type=volume,target=/home/penpot/ \
        --mount type=bind,source="$ROOT",target=/home/penpot/penpot \
        -e EXTERNAL_UID="$(id -u)" \
        -w "/home/penpot/penpot/${mod}" \
        penpotapp/devenv:latest \
        sudo -EH -u penpot ./scripts/build "$TAG"
}

if [[ "$SKIP_BUNDLES" -eq 0 ]]; then
    if ! docker image inspect penpotapp/devenv:latest >/dev/null 2>&1; then
        docker pull penpotapp/devenv:latest
    fi
    if ! docker image inspect penpotapp/imagemagick:7.1.2-27 >/dev/null 2>&1; then
        docker pull penpotapp/imagemagick:7.1.2-27
    fi
    for mod in "${MODULES[@]}"; do
        build_bundle "$mod"
    done
fi

stage_one() {
    local mod=$1 dest=$2 src=$3
    if [[ ! -d "$src" ]]; then
        echo "missing build output for $mod: $src" >&2
        exit 1
    fi
    rm -rf "$dest"
    mkdir -p "$dest"
    cp -a "$src"/. "$dest"/
    echo "$TAG" > "$dest/version.txt"
    put_license "$dest"
}

CONTEXT=$(mktemp -d /var/tmp/penpot-image-context.XXXXXX)
cleanup() { rm -rf "$CONTEXT"; }
trap cleanup EXIT

cp -a "$ROOT/docker/images/." "$CONTEXT/"
rm -rf "$CONTEXT/bundle-frontend" "$CONTEXT/bundle-backend" \
       "$CONTEXT/bundle-exporter" "$CONTEXT/bundle-mcp"

stage_one frontend "$CONTEXT/bundle-frontend" "$ROOT/frontend/target/dist"
stage_one backend  "$CONTEXT/bundle-backend"  "$ROOT/backend/target/dist"
stage_one exporter "$CONTEXT/bundle-exporter" "$ROOT/exporter/target"
stage_one mcp      "$CONTEXT/bundle-mcp"      "$ROOT/mcp/dist"

if [[ "$PUBLIC_BASES" -eq 1 ]]; then
    # Longer (-dev) tags first so the runtime tag is not a prefix match.
    sed -i \
        -e 's|dhi.io/nginx:1.31.1-debian13-dev|nginx:1.31.1-trixie|g' \
        -e 's|dhi.io/debian-base:trixie-debian13-dev|debian:trixie|g' \
        -e 's|dhi.io/node:24.20.0-debian13-dev|node:24.20.0-trixie|g' \
        -e 's|dhi.io/node:24.20.0-debian13|node:24.20.0-trixie|g' \
        "$CONTEXT"/Dockerfile.*
    echo "public-base FROM lines:"
    grep -n '^FROM ' "$CONTEXT"/Dockerfile.frontend "$CONTEXT"/Dockerfile.backend \
        "$CONTEXT"/Dockerfile.exporter "$CONTEXT"/Dockerfile.mcp
fi

for mod in "${MODULES[@]}"; do
    echo "===== image $mod $(date -Is) ====="
    docker build \
        -t "${PREFIX}/${mod}:${TAG}" \
        -f "$CONTEXT/Dockerfile.${mod}" \
        "$CONTEXT"
done

echo "===== built ====="
docker image inspect \
    --format '{{.RepoTags}} {{.Id}} created={{.Created}}' \
    "${PREFIX}/frontend:${TAG}" \
    "${PREFIX}/backend:${TAG}" \
    "${PREFIX}/exporter:${TAG}" \
    "${PREFIX}/mcp:${TAG}"
