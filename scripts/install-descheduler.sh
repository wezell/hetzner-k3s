#!/usr/bin/env bash
# scripts/install-descheduler.sh — Install the Kubernetes Descheduler via Helm
#
# The descheduler runs as a CronJob every 5 minutes and rebalances pods across
# nodes by evicting pods that violate configured policies. This is important for
# the multi-tenant dotCMS cluster because:
#   - Tenant namespaces are added/removed dynamically
#   - Pods may cluster on nodes that had free capacity at scheduling time
#   - LowNodeUtilization ensures even spread across the Hetzner node pool
#
# Strategies enabled:
#   RemoveDuplicates              — evict extra replicas on the same node
#   LowNodeUtilization            — rebalance away from hot nodes
#   RemovePodsViolatingInterPodAntiAffinity — enforce anti-affinity rules post-schedule
#   RemovePodsViolatingNodeAffinity         — enforce node affinity post-schedule
#
# Called by deploy.sh phase 13. Must be idempotent.

set -euo pipefail

DESCHEDULER_NAMESPACE="kube-system"
DESCHEDULER_RELEASE="descheduler"
DESCHEDULER_VERSION="0.32.2"   # matches Kubernetes 1.32.x
WAIT_TIMEOUT=180                # seconds

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
log()  { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}WARN:${NC} $*"; }
err()  { echo -e "${RED}ERROR:${NC} $*" >&2; }
info() { echo "    $*"; }

# ── Check if descheduler is already deployed ──────────────────────────────────
descheduler_installed() {
  helm status "${DESCHEDULER_RELEASE}" -n "${DESCHEDULER_NAMESPACE}" >/dev/null 2>&1
}

# ── Install descheduler via Helm ──────────────────────────────────────────────
install_descheduler() {
  log "Installing Kubernetes Descheduler ${DESCHEDULER_VERSION} via Helm (CronJob mode)"

  helm install "${DESCHEDULER_RELEASE}" descheduler/descheduler \
    --version "${DESCHEDULER_VERSION}" \
    --namespace "${DESCHEDULER_NAMESPACE}" \
    --set kind=CronJob \
    --set schedule="*/5 * * * *" \
    --set image.repository=registry.k8s.io/descheduler/descheduler \
    --set image.tag="v${DESCHEDULER_VERSION}" \
    --set resources.requests.cpu=100m \
    --set resources.requests.memory=128Mi \
    --set resources.limits.cpu=250m \
    --set resources.limits.memory=256Mi \
    --set deschedulerPolicy.strategies.RemoveDuplicates.enabled=true \
    --set deschedulerPolicy.strategies.LowNodeUtilization.enabled=true \
    --set 'deschedulerPolicy.strategies.LowNodeUtilization.params.nodeResourceUtilizationThresholds.thresholds.cpu=20' \
    --set 'deschedulerPolicy.strategies.LowNodeUtilization.params.nodeResourceUtilizationThresholds.thresholds.memory=20' \
    --set 'deschedulerPolicy.strategies.LowNodeUtilization.params.nodeResourceUtilizationThresholds.thresholds.pods=20' \
    --set 'deschedulerPolicy.strategies.LowNodeUtilization.params.nodeResourceUtilizationThresholds.targetThresholds.cpu=50' \
    --set 'deschedulerPolicy.strategies.LowNodeUtilization.params.nodeResourceUtilizationThresholds.targetThresholds.memory=50' \
    --set 'deschedulerPolicy.strategies.LowNodeUtilization.params.nodeResourceUtilizationThresholds.targetThresholds.pods=50' \
    --set deschedulerPolicy.strategies.RemovePodsViolatingInterPodAntiAffinity.enabled=true \
    --set deschedulerPolicy.strategies.RemovePodsViolatingNodeAffinity.enabled=true \
    --set 'deschedulerPolicy.strategies.RemovePodsViolatingNodeAffinity.params.nodeAffinityType[0]=requiredDuringSchedulingIgnoredDuringExecution' \
    --wait=false

  info "Descheduler Helm release created"
}

# ── Wait for the descheduler CronJob to be registered ────────────────────────
wait_for_cronjob() {
  log "Waiting for descheduler CronJob to be registered (timeout: ${WAIT_TIMEOUT}s)..."

  local deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
  local ready=false

  while [[ $(date +%s) -lt ${deadline} ]]; do
    local cj_count
    cj_count=$(kubectl get cronjob -n "${DESCHEDULER_NAMESPACE}" \
      --selector='app.kubernetes.io/name=descheduler' \
      --no-headers 2>/dev/null | wc -l | tr -d ' ')

    if [[ "${cj_count}" -gt 0 ]]; then
      ready=true
      break
    fi

    info "Waiting for descheduler CronJob to appear..."
    sleep 5
  done

  if [[ "${ready}" != "true" ]]; then
    err "Descheduler CronJob did not appear within ${WAIT_TIMEOUT}s"
    kubectl get all -n "${DESCHEDULER_NAMESPACE}" -l app.kubernetes.io/name=descheduler 2>/dev/null || true
    exit 1
  fi

  # Print the CronJob schedule for confirmation
  local schedule
  schedule=$(kubectl get cronjob -n "${DESCHEDULER_NAMESPACE}" \
    --selector='app.kubernetes.io/name=descheduler' \
    -o jsonpath='{.items[0].spec.schedule}' 2>/dev/null || echo "unknown")
  info "Descheduler CronJob registered — schedule: ${schedule}"
}

# ── Main ──────────────────────────────────────────────────────────────────────
if descheduler_installed; then
  info "Descheduler Helm release '${DESCHEDULER_RELEASE}' already present in ${DESCHEDULER_NAMESPACE}"
else
  install_descheduler
fi

wait_for_cronjob

log "Descheduler phase complete — pod rebalancing active (every 5 minutes)"
