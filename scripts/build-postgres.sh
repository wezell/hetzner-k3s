#!/usr/bin/env bash
# build-postgres.sh — Build and push the custom CNPG PostgreSQL image.
# Includes: pgvector + pgvectorscale on PostgreSQL 18.
#
# Usage: source .env && ./scripts/build-postgres.sh [--push]
# Requires: docker (buildx), POSTGRES_IMAGE set in .env

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTEXT_DIR="$(cd "${SCRIPT_DIR}/../postgres-cnpg" && pwd)"

: "${POSTGRES_IMAGE:?POSTGRES_IMAGE must be set in .env (e.g. dotcms/cnpg-postgresql:18)}"

echo "==> Building custom CNPG PostgreSQL image: ${POSTGRES_IMAGE}"

PUSH_FLAG=""
[[ "${1:-}" == "--push" ]] && PUSH_FLAG="--push"

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag "${POSTGRES_IMAGE}" \
  ${PUSH_FLAG} \
  "${CONTEXT_DIR}"

echo "==> Done. Update POSTGRES_IMAGE in manifests/postgres-cluster.yaml if tag changed."
