#!/usr/bin/env bash
# scripts/install-monitoring.sh — Install Prometheus + Grafana + Loki via Helm
#
# Phase 1: kube-prometheus-stack (Prometheus Operator, Prometheus, Grafana,
#          Alertmanager) — cluster-wide metrics collection, alerting, dashboards.
# Phase 2: Grafana Loki (SingleBinary mode) — log aggregation with per-tenant
#          isolation via X-Scope-OrgID header. Backed by Wasabi S3 object storage.
#
# Required .env variables (sourced before calling deploy.sh):
#   GRAFANA_ADMIN_PASSWORD   — Grafana admin password (default: admin)
#   WASABI_ACCESS_KEY        — Wasabi S3 access key (used for Loki log storage)
#   WASABI_SECRET_KEY        — Wasabi S3 secret key
#   WASABI_LOKI_BUCKET       — Dedicated Wasabi bucket for Loki logs (e.g. dotcms-loki-logs)
#
# Called by deploy.sh phase 10. Must be idempotent.
#
# Usage (standalone):
#   source .env && KUBECONFIG=./kubeconfig ./scripts/install-monitoring.sh

set -euo pipefail

MONITORING_NAMESPACE="monitoring"

# kube-prometheus-stack
PROMETHEUS_HELM_RELEASE="kube-prometheus-stack"
PROMETHEUS_CHART_VERSION="61.9.0"

# Loki
LOKI_HELM_RELEASE="loki"
LOKI_CHART_VERSION="6.16.0"   # grafana/loki chart v6.x (Loki 3.x binary)

WAIT_TIMEOUT=300  # 5 minutes — image pulls can be slow on first deploy

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
log()  { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}WARN:${NC} $*"; }
err()  { echo -e "${RED}ERROR:${NC} $*" >&2; }
info() { echo "    $*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Env var defaults ──────────────────────────────────────────────────────────
GRAFANA_ADMIN_PASSWORD="${GRAFANA_ADMIN_PASSWORD:-admin}"
WASABI_ACCESS_KEY="${WASABI_ACCESS_KEY:-}"
WASABI_SECRET_KEY="${WASABI_SECRET_KEY:-}"
WASABI_LOKI_BUCKET="${WASABI_LOKI_BUCKET:-}"

# ── Validate required env vars for Loki ───────────────────────────────────────
for var in WASABI_ACCESS_KEY WASABI_SECRET_KEY WASABI_LOKI_BUCKET; do
  if [[ -z "${!var:-}" ]]; then
    err "Required env var ${var} is not set. Source .env before running this script."
    exit 1
  fi
done

# ── Ensure namespace exists ───────────────────────────────────────────────────
kubectl create namespace "${MONITORING_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

# ── Helper: generic pod readiness gate ───────────────────────────────────────
# Usage: wait_for_pods LABEL TIMEOUT_SECONDS COMPONENT_NAME
wait_for_pods() {
  local label="$1"
  local timeout="$2"
  local name="$3"
  local deadline=$(( $(date +%s) + timeout ))
  local ready=false

  while [[ $(date +%s) -lt ${deadline} ]]; do
    if kubectl wait pod \
        -n "${MONITORING_NAMESPACE}" \
        -l "${label}" \
        --for=condition=Ready \
        --timeout=10s >/dev/null 2>&1; then
      ready=true
      break
    fi
    local running
    running=$(kubectl get pods -n "${MONITORING_NAMESPACE}" \
      -l "${label}" --no-headers 2>/dev/null | grep -c "Running" || echo "0")
    info "  ${name}: ${running} Running (waiting for Ready...)"
    sleep 10
  done

  if [[ "${ready}" != "true" ]]; then
    warn "${name} pod(s) did not reach Ready within ${timeout}s"
    warn "They may need additional time after image pulls complete"
    kubectl get pods -n "${MONITORING_NAMESPACE}" -l "${label}" 2>/dev/null || true
    return 1
  fi

  info "  ${name}: Ready"
  return 0
}

# ══════════════════════════════════════════════════════════════════════════════
# Phase 1: kube-prometheus-stack
# ══════════════════════════════════════════════════════════════════════════════
PROMETHEUS_VALUES="${SCRIPT_DIR}/values/prometheus-values.yaml"

if [[ ! -f "${PROMETHEUS_VALUES}" ]]; then
  err "Values file not found: ${PROMETHEUS_VALUES}"
  exit 1
fi

if helm status "${PROMETHEUS_HELM_RELEASE}" -n "${MONITORING_NAMESPACE}" >/dev/null 2>&1; then
  info "kube-prometheus-stack already installed — upgrading"
  PROM_CMD="upgrade"
else
  PROM_CMD="install"
fi

log "${PROM_CMD^} kube-prometheus-stack ${PROMETHEUS_CHART_VERSION} in ${MONITORING_NAMESPACE}..."

helm "${PROM_CMD}" "${PROMETHEUS_HELM_RELEASE}" prometheus-community/kube-prometheus-stack \
  --version "${PROMETHEUS_CHART_VERSION}" \
  --namespace "${MONITORING_NAMESPACE}" \
  --values "${PROMETHEUS_VALUES}" \
  --set grafana.adminPassword="${GRAFANA_ADMIN_PASSWORD}" \
  --wait=false

info "kube-prometheus-stack Helm release submitted"

# Readiness gates — operator first, then Grafana
log "Waiting for prometheus-operator to be Ready (timeout: ${WAIT_TIMEOUT}s)..."
wait_for_pods "app.kubernetes.io/name=prometheus-operator" "${WAIT_TIMEOUT}" "prometheus-operator" || true

log "Waiting for Grafana to be Ready (timeout: ${WAIT_TIMEOUT}s)..."
wait_for_pods "app.kubernetes.io/name=grafana" "${WAIT_TIMEOUT}" "grafana" || true

log "kube-prometheus-stack phase complete"

# ══════════════════════════════════════════════════════════════════════════════
# Phase 2: Loki (SingleBinary, Wasabi S3 backend)
# ══════════════════════════════════════════════════════════════════════════════
LOKI_VALUES="${SCRIPT_DIR}/values/loki-values.yaml"

if [[ ! -f "${LOKI_VALUES}" ]]; then
  err "Values file not found: ${LOKI_VALUES}"
  exit 1
fi

if helm status "${LOKI_HELM_RELEASE}" -n "${MONITORING_NAMESPACE}" >/dev/null 2>&1; then
  info "Loki already installed — upgrading"
  LOKI_CMD="upgrade"
else
  LOKI_CMD="install"
fi

log "${LOKI_CMD^} Loki ${LOKI_CHART_VERSION} in ${MONITORING_NAMESPACE}..."

helm "${LOKI_CMD}" "${LOKI_HELM_RELEASE}" grafana/loki \
  --version "${LOKI_CHART_VERSION}" \
  --namespace "${MONITORING_NAMESPACE}" \
  --values "${LOKI_VALUES}" \
  --set loki.storage.s3.accessKeyId="${WASABI_ACCESS_KEY}" \
  --set loki.storage.s3.secretAccessKey="${WASABI_SECRET_KEY}" \
  --set loki.storage.bucketNames.chunks="${WASABI_LOKI_BUCKET}" \
  --set loki.storage.bucketNames.ruler="${WASABI_LOKI_BUCKET}" \
  --set loki.storage.bucketNames.admin="${WASABI_LOKI_BUCKET}" \
  --wait=false

info "Loki Helm release submitted"

# Readiness gate — loki singleBinary pod
log "Waiting for Loki SingleBinary pod to be Ready (timeout: ${WAIT_TIMEOUT}s)..."
wait_for_pods "app.kubernetes.io/name=loki,app.kubernetes.io/component=single-binary" \
  "${WAIT_TIMEOUT}" "loki" || true

# Readiness gate — Promtail DaemonSet (non-fatal; may lag on large clusters)
log "Waiting for Promtail DaemonSet pods to be Ready (timeout: ${WAIT_TIMEOUT}s)..."
deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
promtail_ready=false
while [[ $(date +%s) -lt ${deadline} ]]; do
  desired=$(kubectl get daemonset -n "${MONITORING_NAMESPACE}" \
    -l "app.kubernetes.io/name=promtail" \
    -o jsonpath='{.items[0].status.desiredNumberScheduled}' 2>/dev/null || echo "0")
  ready_ds=$(kubectl get daemonset -n "${MONITORING_NAMESPACE}" \
    -l "app.kubernetes.io/name=promtail" \
    -o jsonpath='{.items[0].status.numberReady}' 2>/dev/null || echo "0")
  if [[ "${desired}" -gt 0 && "${ready_ds}" -eq "${desired}" ]]; then
    promtail_ready=true
    break
  fi
  info "  promtail: ${ready_ds:-0}/${desired:-?} pods Ready"
  sleep 10
done

if [[ "${promtail_ready}" != "true" ]]; then
  warn "Promtail DaemonSet pods did not all reach Ready within ${WAIT_TIMEOUT}s"
  warn "This is non-fatal — Promtail will recover once nodes pull the image"
  kubectl get pods -n "${MONITORING_NAMESPACE}" \
    -l "app.kubernetes.io/name=promtail" --no-headers 2>/dev/null || true
else
  info "  promtail: all DaemonSet pods Ready"
fi

log "Loki phase complete"
log "Monitoring stack fully deployed (kube-prometheus-stack + Loki)"
