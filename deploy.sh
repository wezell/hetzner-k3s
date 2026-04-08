#!/usr/bin/env bash
# deploy.sh — Deploy cluster-wide infrastructure onto an existing k3s cluster
#
# Assumes the k3s cluster is already running (provisioned via hetzner-k3s CLI).
# This script installs all shared operators and services needed before tenants
# can be provisioned: ingress (Caddy), CNPG, OpenSearch, CSI-S3, and monitoring.
#
# Usage:
#   source .env && ./deploy.sh              # full deploy, all phases
#   source .env && ./deploy.sh --dry-run    # validate prereqs and print plan
#   source .env && ./deploy.sh --phase 3    # run only phase 3
#   source .env && ./deploy.sh --skip 2,4  # run all phases except 2 and 4
#
# Required .env variables (see .env.example):
#   KUBECONFIG            — path to kubeconfig for the k3s cluster
#   WASABI_ACCESS_KEY     — Wasabi S3 access key (CSI-S3 + CNPG backup)
#   WASABI_SECRET_KEY     — Wasabi S3 secret key
#   WASABI_REGION         — e.g. us-east-1
#   WASABI_BUCKET         — bucket for CNPG WAL/backup (e.g. dotcms-pg-backup)
#   WASABI_S3FUSE_BUCKET  — bucket for dotCMS assets via CSI-S3 (e.g. dotcms-assets)
#   WASABI_LOKI_BUCKET    — bucket for Loki log storage (e.g. dotcms-loki-logs)
#   ACME_EMAIL            — email for Let's Encrypt (caddy on-demand TLS)
#   BASE_DOMAIN           — apex domain for wildcard DNS (e.g. botcms.cloud)
#   CADDY_ADMIN_DOMAIN    — FQDN for Caddy admin API (e.g. caddy-admin.botcms.cloud)
#   GRAFANA_ADMIN_PASSWORD — Grafana admin password (exposed at observe.BASE_DOMAIN)
#   HCLOUD_TOKEN          — Hetzner Cloud token (for cloud controller secret)
#   HETZNER_DNS_TOKEN     — Hetzner DNS API token (for wildcard DNS record, phase 6)
#
# Prerequisites: kubectl, helm, envsubst (gettext), curl

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFESTS_DIR="${SCRIPT_DIR}/manifests"
KUBECONFIG="${KUBECONFIG:-${SCRIPT_DIR}/kubeconfig}"

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
log()  { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}WARN:${NC} $*"; }
err()  { echo -e "${RED}ERROR:${NC} $*" >&2; }
info() { echo "    $*"; }

# ── Argument parsing ──────────────────────────────────────────────────────────
DRY_RUN=false
ONLY_PHASE=""
SKIP_PHASES=""

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Options:
  --dry-run          Validate prerequisites and print deploy plan; make no changes
  --phase  N         Run only phase N (1-14)
  --skip   N[,N...]  Skip phase(s) by number (comma-separated)
  -h, --help         Show this help

Phases:
  1  Helm repos          — add/update all chart repositories
  2  Namespaces          — create cluster-level namespaces
  3  Cilium CNI          — verify/install Cilium and wait for CNI readiness
  4  cert-manager        — CRD + webhook TLS for cluster operators (not used for tenant certs)
  5  Caddy ingress       — on-demand TLS via cname_router plugin
  6  Wildcard DNS        — *.BASE_DOMAIN A record → Caddy LB IP via Hetzner DNS API
  7  CNPG operator       — CloudNativePG for shared Postgres clusters
  8  OpenSearch operator — OpenSearch operator CRDs and controller
  9  OpenSearch cluster  — shared OpenSearch cluster for tenant search indices
  10 CSI-S3              — Wasabi-backed geesefs storage class (s3-fuse StorageClass)
  11 Postgres cluster    — shared CNPG cluster with TimescaleDB
  12 Monitoring          — Prometheus + Grafana (observe.BASE_DOMAIN) + Loki
  13 Descheduler         — CronJob-based pod rebalancing across nodes (every 5 minutes)
  14 Valkey              — shared Redis-compatible cache for tenant session/caching
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)   DRY_RUN=true; shift ;;
    --phase)     ONLY_PHASE="$2"; shift 2 ;;
    --skip)      SKIP_PHASES="$2"; shift 2 ;;
    -h|--help)   usage ;;
    *)           err "Unknown argument: $1"; usage ;;
  esac
done

# ── .env validation ───────────────────────────────────────────────────────────
# Variables must be set in the environment before running (source .env)
REQUIRED_VARS=(
  WASABI_ACCESS_KEY
  WASABI_SECRET_KEY
  WASABI_REGION
  WASABI_BUCKET
  WASABI_S3FUSE_BUCKET
  WASABI_LOKI_BUCKET
  ACME_EMAIL
  BASE_DOMAIN
  CADDY_ADMIN_DOMAIN
  CADDY_ADMIN_USER
  CADDY_ADMIN_PASSWORD
  GRAFANA_ADMIN_PASSWORD
  HCLOUD_TOKEN
  HETZNER_DNS_TOKEN
)

missing=()
for var in "${REQUIRED_VARS[@]}"; do
  [[ -z "${!var:-}" ]] && missing+=("$var")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  err "Missing required environment variables (source .env first):"
  for v in "${missing[@]}"; do err "  $v"; done
  exit 1
fi

# ── Prerequisite checks ───────────────────────────────────────────────────────
log "Pre-flight checks"

REQUIRED_CMDS=(kubectl helm envsubst curl)
for cmd in "${REQUIRED_CMDS[@]}"; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "Required command not found: $cmd"
    exit 1
  fi
  info "$(command -v "$cmd") — OK"
done

# Verify KUBECONFIG resolves and cluster is reachable
if [[ ! -f "${KUBECONFIG}" ]]; then
  err "KUBECONFIG not found: ${KUBECONFIG}"
  exit 1
fi
export KUBECONFIG

info "Testing cluster connectivity..."
if ! kubectl cluster-info --request-timeout=10s >/dev/null 2>&1; then
  err "Cannot reach Kubernetes API. Check KUBECONFIG and cluster status."
  exit 1
fi
SERVER_VERSION=$(kubectl version --short 2>/dev/null | grep "Server Version" | awk '{print $3}' || \
                 kubectl version 2>/dev/null | grep "Server Version" | awk '{print $3}')
info "Cluster reachable — Server: ${SERVER_VERSION:-unknown}"

# ── Phase gate helpers ────────────────────────────────────────────────────────
should_run_phase() {
  local phase_num="$1"
  # If --phase N is set, only run that phase
  if [[ -n "${ONLY_PHASE}" ]]; then
    [[ "${phase_num}" == "${ONLY_PHASE}" ]] && return 0 || return 1
  fi
  # If --skip N,M,... is set, skip listed phases
  if [[ -n "${SKIP_PHASES}" ]]; then
    IFS=',' read -ra skips <<< "${SKIP_PHASES}"
    for s in "${skips[@]}"; do
      [[ "${phase_num}" == "${s}" ]] && return 1
    done
  fi
  return 0
}

run_phase() {
  local num="$1"
  local name="$2"
  local fn="$3"
  if should_run_phase "${num}"; then
    log "Phase ${num}: ${name}"
    if [[ "${DRY_RUN}" == "true" ]]; then
      info "[DRY-RUN] Would execute: ${fn}"
    else
      "${fn}"
    fi
  else
    info "Phase ${num}: ${name} — SKIPPED"
  fi
}

# ── Phase 1: Helm repos ───────────────────────────────────────────────────────
phase_helm_repos() {
  helm repo add cert-manager https://charts.jetstack.io                                  2>/dev/null || true
  helm repo add cilium       https://helm.cilium.io                                      2>/dev/null || true
  helm repo add caddy        https://caddyserver.github.io/ingress                       2>/dev/null || true
  helm repo add cnpg         https://cloudnative-pg.github.io/charts                    2>/dev/null || true
  helm repo add opensearch   https://opensearch-project.github.io/opensearch-k8s-operator/ 2>/dev/null || true
  helm repo add csi-s3       https://yandex-cloud.github.io/k8s-csi-s3/charts           2>/dev/null || true
  helm repo add prometheus   https://prometheus-community.github.io/helm-charts         2>/dev/null || true
  helm repo add grafana      https://grafana.github.io/helm-charts                      2>/dev/null || true
  helm repo add descheduler  https://kubernetes-sigs.github.io/descheduler/             2>/dev/null || true
  # Valkey uses OCI chart — no repo add needed; pulled directly in install-valkey.sh
  helm repo update
  info "Helm repos updated"
}

# ── Phase 2: Namespaces ───────────────────────────────────────────────────────
phase_namespaces() {
  for ns in caddy cnpg-system opensearch postgres monitoring valkey; do
    kubectl create namespace "${ns}" --dry-run=client -o yaml | kubectl apply -f -
  done
  info "Namespaces ensured"
}

# ── Phase 3: Cilium CNI ───────────────────────────────────────────────────────
phase_cilium() {
  "${SCRIPT_DIR}/scripts/install-cilium.sh"
}

# ── Phase 4: cert-manager ─────────────────────────────────────────────────────
phase_cert_manager() {
  "${SCRIPT_DIR}/scripts/install-cert-manager.sh"
}

# ── Phase 5: Caddy ingress + ClusterIssuers ───────────────────────────────────
phase_caddy() {
  "${SCRIPT_DIR}/scripts/install-caddy.sh"
  apply_cluster_issuers
}

# Apply Let's Encrypt ClusterIssuers and block until letsencrypt-botcms is Ready.
# cert-manager must be installed (phase 4) before this runs.
apply_cluster_issuers() {
  local manifest="${MANIFESTS_DIR}/cluster-issuer.yaml"
  local issuer_name="letsencrypt-botcms"
  local timeout=120  # seconds — account registration is fast once LE is reachable

  log "Applying Let's Encrypt ClusterIssuers (${BASE_DOMAIN:-botcms.cloud})..."

  if [[ ! -f "${manifest}" ]]; then
    err "ClusterIssuer manifest not found: ${manifest}"
    exit 1
  fi

  # Substitute ACME_EMAIL and BASE_DOMAIN before applying
  envsubst '${ACME_EMAIL} ${BASE_DOMAIN}' < "${manifest}" | kubectl apply -f -
  info "ClusterIssuer manifests applied"

  # ── Wait for letsencrypt-botcms to reach Ready=True ─────────────────────────
  # The Ready condition is set once cert-manager registers the ACME account key
  # with Let's Encrypt. This does NOT require solving a challenge.
  log "Waiting for ClusterIssuer '${issuer_name}' to reach Ready=True (timeout: ${timeout}s)..."

  local deadline=$(( $(date +%s) + timeout ))
  local ready=false

  while [[ $(date +%s) -lt ${deadline} ]]; do
    local status
    status=$(kubectl get clusterissuer "${issuer_name}" \
      -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "")

    if [[ "${status}" == "True" ]]; then
      ready=true
      break
    fi

    local reason
    reason=$(kubectl get clusterissuer "${issuer_name}" \
      -o jsonpath='{.status.conditions[?(@.type=="Ready")].reason}' 2>/dev/null || echo "pending")
    info "ClusterIssuer status: ${reason:-waiting} — retrying in 10s..."
    sleep 10
  done

  if [[ "${ready}" != "true" ]]; then
    err "ClusterIssuer '${issuer_name}' did not reach Ready=True within ${timeout}s"
    kubectl describe clusterissuer "${issuer_name}" 2>/dev/null || true
    exit 1
  fi

  info "ClusterIssuer '${issuer_name}' is Ready"
  info "ClusterIssuer 'letsencrypt-staging' applied (status not gated)"
}

# ── Phase 6: Wildcard DNS ─────────────────────────────────────────────────────
phase_dns() {
  "${SCRIPT_DIR}/scripts/configure-dns.sh"
}

# ── Phase 7: CNPG operator ────────────────────────────────────────────────────
phase_cnpg() {
  "${SCRIPT_DIR}/scripts/install-cnpg.sh"
}

# ── Phase 8: OpenSearch ───────────────────────────────────────────────────────
phase_opensearch() {
  "${SCRIPT_DIR}/scripts/install-opensearch.sh"
}

# ── Phase 9: OpenSearch cluster ──────────────────────────────────────────────
phase_opensearch_cluster() {
  "${SCRIPT_DIR}/scripts/install-opensearch-cluster.sh"
}

# ── Phase 10: CSI-S3 ─────────────────────────────────────────────────────────
phase_csi_s3() {
  "${SCRIPT_DIR}/scripts/install-csi-s3.sh"
}

# ── Phase 11: Postgres cluster ────────────────────────────────────────────────
phase_postgres_cluster() {
  "${SCRIPT_DIR}/scripts/install-postgres-cluster.sh"
}

# ── Phase 12: Monitoring ──────────────────────────────────────────────────────
phase_monitoring() {
  "${SCRIPT_DIR}/scripts/install-monitoring.sh"
}

# ── Phase 13: Descheduler ─────────────────────────────────────────────────────
phase_descheduler() {
  "${SCRIPT_DIR}/scripts/install-descheduler.sh"
}

# ── Phase 14: Valkey ──────────────────────────────────────────────────────────
phase_valkey() {
  "${SCRIPT_DIR}/scripts/install-valkey.sh"
}

# ── Dry-run plan summary ──────────────────────────────────────────────────────
if [[ "${DRY_RUN}" == "true" ]]; then
  echo ""
  echo "======================================================"
  echo "DRY-RUN MODE — no changes will be made"
  echo "======================================================"
  echo "  KUBECONFIG:  ${KUBECONFIG}"
  echo "  Cluster:     ${SERVER_VERSION:-unknown}"
  echo "  Manifests:   ${MANIFESTS_DIR}"
  echo ""
  echo "Phases to execute:"
fi

# ── Ordered phase execution ───────────────────────────────────────────────────
run_phase 1  "Helm repos"          phase_helm_repos
run_phase 2  "Namespaces"          phase_namespaces
run_phase 3  "Cilium CNI"          phase_cilium
run_phase 4  "cert-manager"        phase_cert_manager
run_phase 5  "Caddy ingress"       phase_caddy
run_phase 6  "Wildcard DNS"        phase_dns
run_phase 7  "CNPG operator"       phase_cnpg
run_phase 8  "OpenSearch operator"  phase_opensearch
run_phase 9  "OpenSearch cluster"  phase_opensearch_cluster
run_phase 10 "CSI-S3"              phase_csi_s3
run_phase 11 "Postgres cluster"    phase_postgres_cluster
run_phase 12 "Monitoring"          phase_monitoring
run_phase 13 "Descheduler"         phase_descheduler
run_phase 14 "Valkey"              phase_valkey

# ── Post-deploy: verify core cluster components ───────────────────────────────
# Only run full verification on a complete (non-phase-specific) deploy.
# Skipped in dry-run mode and when --phase targets a single phase.
if [[ "${DRY_RUN}" != "true" && -z "${ONLY_PHASE}" ]]; then
  log "Post-deploy verification — core cluster components"
  "${SCRIPT_DIR}/scripts/verify-core-components.sh" || {
    err "Core component verification failed — review output above"
    exit 1
  }
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "======================================================"
if [[ "${DRY_RUN}" == "true" ]]; then
  echo "Dry-run complete — cluster unchanged."
else
  echo "Cluster infrastructure deployed successfully."
  echo ""
  echo "  Next step: provision a tenant"
  echo "    source .env && ./tenant-add.sh <tenant> <env>"
fi
echo "======================================================"
