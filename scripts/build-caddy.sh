#!/usr/bin/env bash
# build-caddy.sh — Build and push the custom Caddy ingress image.
# Includes: cname_router plugin (local) + caddy-storage-redis plugin.
#
# Usage: source .env && ./scripts/build-caddy.sh [--push]
# Requires: docker (buildx), CADDY_IMAGE set in .env

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "${SCRIPT_DIR}/../caddy-cname-router" && pwd)"

: "${CADDY_IMAGE:?CADDY_IMAGE must be set in .env (e.g. dotcms/caddy-ingress:latest)}"

echo "==> Building Caddy ingress image: ${CADDY_IMAGE}"
echo "    Plugin source: ${PLUGIN_DIR}"

PUSH_FLAG=""
[[ "${1:-}" == "--push" ]] && PUSH_FLAG="--push"

# Multiarch: --platform=$BUILDPLATFORM in Dockerfile means xcaddy runs
# natively on the build host; GOOS/GOARCH cross-compile the output binary.
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag "${CADDY_IMAGE}" \
  ${PUSH_FLAG} \
  "${PLUGIN_DIR}"

echo "==> Done."
echo "    Update CADDY_IMAGE in caddy-ingress.yaml if the tag changed."
