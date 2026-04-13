#!/usr/bin/env bash
# install-cilium.sh — Install Cilium CNI with native routing on k3s/Hetzner.
#
# The cluster was provisioned with cni.mode=cilium by hetzner-k3s, which means:
#   - k3s flannel is disabled (--flannel-backend=none)
#   - kube-proxy is disabled (--disable=kube-proxy)
#   - Pod CIDR: 10.244.0.0/16
#
# Cilium is installed with native routing (no encapsulation) — Hetzner's private
# network is a flat L2 so tunnelling is unnecessary overhead.
#
# idempotent: skips install if Cilium DaemonSet already exists and is healthy.

set -euo pipefail

KUBECONFIG="${KUBECONFIG:-$(dirname "$0")/../kubeconfig}"
export KUBECONFIG

CILIUM_VERSION="${CILIUM_VERSION:-1.15.6}"
POD_CIDR="${POD_CIDR:-10.244.0.0/16}"
NATIVE_ROUTING_CIDR="${NATIVE_ROUTING_CIDR:-10.0.0.0/8}"  # covers pods + nodes

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}WARN:${NC} $*"; }
err()  { echo -e "${RED}ERROR:${NC} $*" >&2; }

# ── Already installed? ────────────────────────────────────────────────────────
if kubectl get daemonset cilium -n kube-system &>/dev/null 2>&1; then
  READY=$(kubectl get daemonset cilium -n kube-system \
    -o jsonpath='{.status.numberReady}' 2>/dev/null || echo 0)
  DESIRED=$(kubectl get daemonset cilium -n kube-system \
    -o jsonpath='{.status.desiredNumberScheduled}' 2>/dev/null || echo 0)
  if [[ "${READY}" -eq "${DESIRED}" && "${DESIRED}" -gt 0 ]]; then
    log "Cilium already installed and healthy (${READY}/${DESIRED} ready) — skipping"
    exit 0
  fi
  warn "Cilium DaemonSet found but not fully ready (${READY}/${DESIRED}) — re-installing"
  helm uninstall cilium -n kube-system --wait --timeout 2m 2>/dev/null || true
fi

# ── Resolve API server internal IP ───────────────────────────────────────────
# Use the first master's internal IP (Cilium needs direct access to API server,
# not via ClusterIP which it hasn't set up yet).
API_HOST=$(kubectl get nodes \
  -l node-role.kubernetes.io/master="true" \
  -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' \
  2>/dev/null || echo "")

if [[ -z "${API_HOST}" ]]; then
  API_HOST=$(kubectl get nodes \
    -l node-role.kubernetes.io/control-plane="true" \
    -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' \
    2>/dev/null || echo "")
fi

if [[ -z "${API_HOST}" ]]; then
  err "Could not determine master node internal IP for k8sServiceHost"
  err "Set API_HOST env var to override, e.g.: API_HOST=10.0.0.2 source .env && ./deploy.sh"
  exit 1
fi

log "Installing Cilium ${CILIUM_VERSION}"
log "  API server:          ${API_HOST}:6443"
log "  Pod CIDR:            ${POD_CIDR}"
log "  Native routing CIDR: ${NATIVE_ROUTING_CIDR}"
log "  Mode:   native routing + BPF masquerade + egress gateway"
log "  Note:   autoDirectNodeRoutes=false — Hetzner SDN routes handle inter-node pod traffic"

# ── Helm install ──────────────────────────────────────────────────────────────
# Native routing without autoDirectNodeRoutes — Hetzner's private network already
# has routes for each node's pod CIDR (added by hetzner-k3s on cluster creation).
# Pod traffic flows: pod → kernel default route → Hetzner gateway 10.0.0.1
# → Hetzner network route → destination node. No tunneling overhead.
helm upgrade --install cilium cilium/cilium \
  --version "${CILIUM_VERSION}" \
  --namespace kube-system \
  --wait \
  --timeout 5m \
  --set routingMode=native \
  --set autoDirectNodeRoutes=false \
  --set ipv4NativeRoutingCIDR="${NATIVE_ROUTING_CIDR}" \
  --set ipam.mode=kubernetes \
  --set "k8s.requireIPv4PodCIDR=true" \
  --set ipam.operator.clusterPoolIPv4PodCIDRList="${POD_CIDR}" \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost="${API_HOST}" \
  --set k8sServicePort=6443 \
  --set endpointRoutes.enabled=true \
  --set loadBalancer.acceleration=native \
  --set bpf.masquerade=true \
  --set egressGateway.enabled=true \
  --set MTU=1450 \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true \
  --set operator.replicas=1

log "Cilium installed — waiting for DaemonSet rollout (timeout: 5m)..."
kubectl rollout status daemonset/cilium -n kube-system --timeout=300s

READY=$(kubectl get daemonset cilium -n kube-system \
  -o jsonpath='{.status.numberReady}' 2>/dev/null || echo 0)
DESIRED=$(kubectl get daemonset cilium -n kube-system \
  -o jsonpath='{.status.desiredNumberScheduled}' 2>/dev/null || echo 0)
log "Cilium ready: ${READY}/${DESIRED} nodes"
