#!/usr/bin/env bash
# scripts/verify-prometheus-targets.sh — Verify Prometheus scrape targets are 'up'
#
# Queries the live Prometheus API via kubectl port-forward to confirm all
# expected scrape jobs are present and in 'up' state.
#
# Expected targets for a healthy k3s cluster:
#   • kube-state-metrics    — cluster resource metrics (pods, nodes, deployments…)
#   • node-exporter         — per-node OS/hardware metrics
#   • apiserver             — k3s API server (kubernetes svc in default ns)
#   • kubelet               — per-node kubelet metrics (port 10250)
#   • coredns               — CoreDNS DNS query metrics
#   • prometheus-operator   — operator self-metrics
#   • prometheus            — Prometheus self-scrape
#   • alertmanager          — Alertmanager self-metrics
#   • grafana               — Grafana self-metrics
#
# Disabled (k3s-incompatible; set enabled: false in prometheus-values.yaml):
#   etcd, controller-manager, scheduler, kube-proxy
#
# Usage (standalone):
#   KUBECONFIG=./kubeconfig ./scripts/verify-prometheus-targets.sh
#
# Options:
#   --timeout SECONDS   port-forward + HTTP timeout (default: 60)
#   --namespace NS      monitoring namespace (default: monitoring)
#   --local-port PORT   local port for port-forward (default: 19090)

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
MONITORING_NAMESPACE="monitoring"
PROMETHEUS_LOCAL_PORT=19090
WAIT_TIMEOUT=60

while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout)   WAIT_TIMEOUT="$2";           shift 2 ;;
    --namespace) MONITORING_NAMESPACE="$2";   shift 2 ;;
    --local-port) PROMETHEUS_LOCAL_PORT="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}WARN:${NC} $*"; }
err()  { echo -e "${RED}ERROR:${NC} $*" >&2; }
info() { echo "    $*"; }
step() { echo -e "  ${CYAN}•${NC} $*"; }
ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
fail() { echo -e "  ${RED}✗${NC} $*"; }

# ── Cleanup trap ──────────────────────────────────────────────────────────────
PF_PID=""
cleanup() {
  if [[ -n "${PF_PID}" ]]; then
    kill "${PF_PID}" 2>/dev/null || true
    PF_PID=""
  fi
}
trap cleanup EXIT INT TERM

# ── Prerequisites ─────────────────────────────────────────────────────────────
for cmd in kubectl curl jq; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    err "Required command '${cmd}' not found. Install it before running this script."
    exit 1
  fi
done

# ── Locate the Prometheus pod ─────────────────────────────────────────────────
log "Locating Prometheus pod in namespace '${MONITORING_NAMESPACE}'..."

PROM_POD=$(kubectl get pods \
  -n "${MONITORING_NAMESPACE}" \
  -l "app.kubernetes.io/name=prometheus" \
  --field-selector='status.phase=Running' \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [[ -z "${PROM_POD}" ]]; then
  # Fallback: look by StatefulSet label used in older chart versions
  PROM_POD=$(kubectl get pods \
    -n "${MONITORING_NAMESPACE}" \
    -l "prometheus=kube-prometheus-stack-prometheus" \
    --field-selector='status.phase=Running' \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
fi

if [[ -z "${PROM_POD}" ]]; then
  err "No running Prometheus pod found in namespace '${MONITORING_NAMESPACE}'."
  err "Ensure the monitoring stack is deployed: deploy.sh --phase 12 (or install-monitoring.sh)"
  exit 1
fi

info "Found Prometheus pod: ${PROM_POD}"

# ── Start port-forward ────────────────────────────────────────────────────────
log "Starting port-forward ${PROMETHEUS_LOCAL_PORT} → ${PROM_POD}:9090 ..."

kubectl port-forward \
  -n "${MONITORING_NAMESPACE}" \
  "pod/${PROM_POD}" \
  "${PROMETHEUS_LOCAL_PORT}:9090" \
  >/dev/null 2>&1 &
PF_PID=$!

# Wait for port-forward to be ready
PROM_URL="http://localhost:${PROMETHEUS_LOCAL_PORT}"
pf_deadline=$(( $(date +%s) + 30 ))
pf_ready=false
while [[ $(date +%s) -lt ${pf_deadline} ]]; do
  if curl -sf --max-time 3 "${PROM_URL}/-/healthy" >/dev/null 2>&1; then
    pf_ready=true
    break
  fi
  sleep 2
done

if [[ "${pf_ready}" != "true" ]]; then
  err "Port-forward to Prometheus did not become ready within 30s."
  err "Check that pod '${PROM_POD}' is Running and port 9090 is reachable."
  exit 1
fi

info "Prometheus API reachable at ${PROM_URL}"

# ── Query Prometheus targets API ──────────────────────────────────────────────
log "Querying Prometheus targets API..."

TARGETS_JSON=$(curl -sf --max-time "${WAIT_TIMEOUT}" \
  "${PROM_URL}/api/v1/targets?state=any" 2>/dev/null)

if [[ -z "${TARGETS_JSON}" ]]; then
  err "Empty response from Prometheus targets API."
  exit 1
fi

# ── Parse results ─────────────────────────────────────────────────────────────
# Build a map of job → (up_count, total_count, down_labels)
log "Analysing scrape target health..."
echo ""

# Collect all active targets into a summary per job
JOBS_SUMMARY=$(echo "${TARGETS_JSON}" | jq -r '
  .data.activeTargets
  | group_by(.labels.job)
  | map({
      job: .[0].labels.job,
      total: length,
      up: map(select(.health == "up")) | length,
      down: map(select(.health != "up")) | map(.labels.instance // "?") | join(", ")
    })
  | sort_by(.job)
  | .[]
  | "\(.job)\t\(.up)/\(.total)\t\(.down)"
')

# ── Expected jobs for k3s + kube-prometheus-stack ─────────────────────────────
# These must be present AND have at least one 'up' endpoint.
REQUIRED_JOBS=(
  "kube-state-metrics"
  "node-exporter"
  "apiserver"
  "kubelet"
  "coredns"
  "prometheus"
)

# Additional jobs that should exist but are non-fatal if missing
ADVISORY_JOBS=(
  "prometheus-operator"
  "alertmanager"
  "grafana"
)

# Jobs we explicitly disabled for k3s (should NOT appear)
DISABLED_JOBS=(
  "kube-etcd"
  "kube-controller-manager"
  "kube-scheduler"
  "kube-proxy"
)

declare -A JOB_UP
declare -A JOB_TOTAL
declare -A JOB_DOWN_INSTANCES

while IFS=$'\t' read -r job ratio down_instances; do
  [[ -z "${job}" ]] && continue
  up_count="${ratio%%/*}"
  total_count="${ratio##*/}"
  JOB_UP["${job}"]="${up_count}"
  JOB_TOTAL["${job}"]="${total_count}"
  JOB_DOWN_INSTANCES["${job}"]="${down_instances}"
done <<< "${JOBS_SUMMARY}"

# ── Required jobs check ───────────────────────────────────────────────────────
echo "Required scrape targets:"
FAILED=0

for job in "${REQUIRED_JOBS[@]}"; do
  if [[ -v JOB_UP["${job}"] ]]; then
    up="${JOB_UP[$job]}"
    total="${JOB_TOTAL[$job]}"
    down="${JOB_DOWN_INSTANCES[$job]}"
    if [[ "${up}" -ge 1 ]]; then
      ok "${job}: ${up}/${total} endpoints up"
      if [[ -n "${down}" ]]; then
        warn "  Down instances: ${down}"
        FAILED=$(( FAILED + 1 ))
      fi
    else
      fail "${job}: 0/${total} endpoints up — ALL DOWN"
      if [[ -n "${down}" ]]; then
        info "  Down instances: ${down}"
      fi
      FAILED=$(( FAILED + 1 ))
    fi
  else
    fail "${job}: job not found in Prometheus targets"
    FAILED=$(( FAILED + 1 ))
  fi
done

echo ""
echo "Advisory scrape targets (non-fatal):"
for job in "${ADVISORY_JOBS[@]}"; do
  if [[ -v JOB_UP["${job}"] ]]; then
    up="${JOB_UP[$job]}"
    total="${JOB_TOTAL[$job]}"
    ok "${job}: ${up}/${total} endpoints up"
  else
    warn "${job}: job not found (may not be configured)"
  fi
done

echo ""
echo "Disabled targets (should not appear):"
for job in "${DISABLED_JOBS[@]}"; do
  if [[ -v JOB_UP["${job}"] ]]; then
    warn "${job}: PRESENT but expected to be disabled — check prometheus-values.yaml"
  else
    ok "${job}: correctly absent"
  fi
done

# ── Full target listing ───────────────────────────────────────────────────────
echo ""
echo "All discovered jobs (job | up/total | down instances):"
echo "────────────────────────────────────────────────────────────"
while IFS=$'\t' read -r job ratio down_instances; do
  [[ -z "${job}" ]] && continue
  up="${ratio%%/*}"
  total="${ratio##*/}"
  if [[ "${up}" -eq "${total}" ]]; then
    printf "  ${GREEN}%-45s${NC} %s\n" "${job}" "${ratio}"
  else
    printf "  ${RED}%-45s${NC} %s  ← down: %s\n" "${job}" "${ratio}" "${down_instances}"
  fi
done <<< "${JOBS_SUMMARY}"
echo "────────────────────────────────────────────────────────────"

# ── Check for scrape errors via instant query ─────────────────────────────────
echo ""
log "Checking for recent scrape errors (last 5 minutes)..."

SCRAPE_ERRORS=$(curl -sf --max-time 30 \
  "${PROM_URL}/api/v1/query" \
  --data-urlencode 'query=scrape_samples_scraped == 0' \
  2>/dev/null | jq -r '
    .data.result
    | map(.metric.job + " / " + (.metric.instance // "?"))
    | .[]
  ' 2>/dev/null || echo "")

if [[ -n "${SCRAPE_ERRORS}" ]]; then
  warn "Jobs with zero samples scraped:"
  while IFS= read -r entry; do
    warn "  ${entry}"
  done <<< "${SCRAPE_ERRORS}"
else
  ok "No jobs with zero samples scraped"
fi

# ── Alertmanager connectivity ─────────────────────────────────────────────────
echo ""
log "Checking Alertmanager connectivity from Prometheus..."

AM_STATUS=$(curl -sf --max-time 30 \
  "${PROM_URL}/api/v1/alertmanagers" 2>/dev/null \
  | jq -r '.data.activeAlertmanagers | length' 2>/dev/null || echo "0")

if [[ "${AM_STATUS:-0}" -ge 1 ]]; then
  ok "Alertmanager: ${AM_STATUS} active alertmanager(s) connected"
else
  warn "No active Alertmanagers found — alerts will not be forwarded"
fi

# ── Final verdict ─────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════"
if [[ "${FAILED}" -eq 0 ]]; then
  log "Prometheus scrape target verification PASSED ✓"
  log "All required targets (kube-state-metrics, node-exporter, apiserver, kubelet, coredns, prometheus) are 'up'"
  exit 0
else
  err "Prometheus scrape target verification FAILED — ${FAILED} issue(s) found"
  err "Check the targets above and inspect: kubectl port-forward -n monitoring svc/prometheus-operated 9090:9090"
  err "Then visit http://localhost:9090/targets for the full Prometheus UI"
  exit 1
fi
