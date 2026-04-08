#!/usr/bin/env bash
# build-webhook.sh — Build and push the caddy-webhook container image.
# Usage: source .env && ./scripts/build-webhook.sh [--push]
# Requires: docker (buildx), WEBHOOK_IMAGE set in .env
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WEBHOOK_DIR="${REPO_ROOT}/webhook"

: "${WEBHOOK_IMAGE:?WEBHOOK_IMAGE must be set in .env (e.g. ghcr.io/myorg/caddy-webhook:latest)}"

echo "==> Building caddy-webhook image: ${WEBHOOK_IMAGE}"

# Generate go.sum if missing (requires Go toolchain available).
if [[ ! -f "${WEBHOOK_DIR}/go.sum" ]]; then
  echo "--> Generating go.sum..."
  (cd "${WEBHOOK_DIR}" && go mod tidy)
fi

PUSH_FLAG=""
[[ "${1:-}" == "--push" ]] && PUSH_FLAG="--push"

# Multiarch build: buildx handles the manifest list.
# --push must be passed directly to buildx (not as a separate docker push)
# because multiarch images only exist as a manifest in the registry, not locally.
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag "${WEBHOOK_IMAGE}" \
  ${PUSH_FLAG} \
  "${WEBHOOK_DIR}"

echo "==> Done. Deploy with:"
echo "    kubectl apply -f manifests/caddy-webhook.yaml"
