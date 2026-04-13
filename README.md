# dotCMS k3s — Multi-Tenant Hetzner Infrastructure

Kubernetes cluster on Hetzner Cloud (`ash`) r unning k3s, provisioned via
[hetzner-k3s CLI](https://github.com/vitobotta/hetzner-k3s).
Hosts isolated dotCMS environments at `TENANT-ENV.botcms.cloud`.
  
## Stack

| Component | Details |
|---|---|
| **k3s** | v1.32.0+k3s1 via hetzner-k3s CLI |
| **Cilium** | CNI |
| **Caddy** | Ingress — HA (2 replicas), on-demand TLS, CNAME routing, sticky sessions |
| **Valkey** | Caddy cert storage — shared across replicas via `caddy-storage-redis` plugin |
| **Hetzner CCM + CSI** | Cloud integration |
| **CloudNativePG (CNPG)** | Shared Postgres cluster — one DB + user per `TENANT-ENV` |
| **OpenSearch operator** | Shared OpenSearch cluster — per-tenant users scoped to `TENANT-ENV-*` indices |
| **csi-s3 + geesefs** | S3-backed ReadWriteMany storage — Wasabi prefix `TENANT/TENANT-ENV` |
| **Descheduler** | Bin packing — evicts pods from underutilized nodes every 5 min |
| **Prometheus + Grafana + Loki** | Full observability stack |
| **caddy-webhook** | Go service — validates on-demand TLS requests against live tenant namespaces |

## Node Layout

| Pool | Type | Count | RAM | Notes |
|---|---|---|---|---|
| master1/2/3 | cpx21 | 3 | 4GB | HA control plane |
| pool-medium-worker1/2 | cpx31 | 2 | 8GB | General workloads |
| large | cpx41 | 1–10 | 16GB | Autoscaled |
| x-large | cpx51 | 1–10 | 32GB | Autoscaled |

## Prerequisites

- `kubectl`, `helm`, `envsubst` (gettext), `curl`
- `.env` file with credentials (see `.env.example`)
- Wildcard DNS: `*.botcms.cloud` A → cluster LB IP

## Quick Start

```bash
cp .env.example .env
# Fill in .env with your credentials

# Deploy all cluster-wide infrastructure
source .env && ./deploy.sh

# Add a tenant environment
export TENANT_ID=acme ENV_ID=prod
source .env && ./tenant-add.sh

# Remove a single environment (keeps namespace if other envs remain)
export TENANT_ID=acme ENV_ID=prod
source .env && ./tenant-remove.sh --env-only --yes

# Remove an entire tenant namespace
export TENANT_ID=acme
source .env && ./tenant-remove.sh --yes

# Tear down all infrastructure
source .env && ./destroy.sh
```

## Deploy cluster:

```
brew install vitobotta/tap/hetzner_k3s
hetzner-k3s create --config hetzner-k3-cluster-config.yaml
```



## deploy.sh — Cluster Infrastructure

Installs all shared operators and services in dependency order.

```
Phase 1   Helm repos            — add/update chart repositories
Phase 2   Namespaces            — create infra namespaces
Phase 3   Cilium CNI            — verify/install Cilium
Phase 4   cert-manager          — CRD + webhook TLS
Phase 5   Caddy ingress         — on-demand TLS via cname_router + webhook
Phase 6   Wildcard DNS          — configure *.botcms.cloud → LB IP
Phase 7   CNPG operator         — CloudNativePG
Phase 8   OpenSearch operator   — OpenSearch operator only
Phase 9   OpenSearch cluster    — shared 3-node OpenSearch cluster
Phase 10  CSI-S3                — Wasabi-backed geesefs storage class
Phase 11  Postgres cluster      — shared CNPG cluster
Phase 12  Monitoring            — Prometheus + Grafana + Loki
Phase 13  Descheduler           — bin-packing CronJob
Phase 14  Valkey                — cert storage for Caddy
```

**Options:**
```bash
./deploy.sh --dry-run          # validate prereqs, print plan
./deploy.sh --phase 5          # run only phase 5
./deploy.sh --skip 3,4         # skip phases 3 and 4
```

## destroy.sh — Teardown

Removes all cluster-wide infrastructure in reverse dependency order.

```bash
./destroy.sh                   # fail if tenants still exist
./destroy.sh --force-tenants   # also delete all tenant namespaces (DESTRUCTIVE)
./destroy.sh --purge-crds      # also remove operator CRDs
./destroy.sh --dry-run         # print actions without executing
```

## tenant-add.sh — Provision a Tenant

Creates a namespace-isolated dotCMS environment:

```bash
export TENANT_ID=acme ENV_ID=prod
source .env && ./tenant-add.sh

# Add a second environment to the same tenant (namespace reused)
export TENANT_ID=acme ENV_ID=staging
source .env && ./tenant-add.sh
```

Creates (per `TENANT_ID-ENV_ID` instance):
- Namespace `TENANT_ID` (idempotent)
- Valkey ExternalName service + connection secret
- OpenSearch role + user scoped to `TENANT_ID-ENV_ID-*` indices
- Postgres role + CNPG Database CR; secret `TENANT_ID-ENV_ID-postgres` in tenant ns
- Static PV + PVC (`s3-fuse`) backed by Wasabi prefix `TENANT_ID/TENANT_ID-ENV_ID`
- dotCMS Deployment, HPA (1–6 replicas), PDB, ClusterIP Service, headless Service

Routing and TLS are automatic — once the headless service exists, Caddy routes
`TENANT_ID-ENV_ID.botcms.cloud` and issues a cert on the first HTTPS request.

## tenant-remove.sh — Deprovision a Tenant

```bash
# Remove a single environment (keeps namespace + other envs)
export TENANT_ID=acme ENV_ID=prod
source .env && ./tenant-remove.sh --env-only --yes

# Remove entire tenant (all environments + namespace)
export TENANT_ID=acme
source .env && ./tenant-remove.sh --yes

# Positional args also work (used by destroy.sh --force-tenants)
./tenant-remove.sh acme prod --env-only --yes
```

Drops Postgres DB+role from shared cluster, deletes OpenSearch user/role via
Security API, removes static PV, and cascades namespace deletion.

## Caddy — Ingress & Routing

Runs as a 2-replica HA Deployment. Custom image with `cname_router` and
`caddy-storage-redis` plugins. Cert storage in Valkey (shared across replicas).

```
customer.com  ──CNAME──▶  acme-prod.botcms.cloud  ──A──▶  LB IP
                                  │
                           cname_router plugin
                                  │
                    DNS: acme-prod-hl.acme.svc.cluster.local
                                  │
                         dotCMS pod (sticky via lb_session cookie)
```

## PostgreSQL — CloudNativePG

- One database per environment (`TENANT-ENV`)
- Shared 3-node CNPG cluster in `postgres` namespace
- Image: `dotcms/cnpg-postgresql:18` — custom build on PG 18 with pgvector + pgvectorscale
- Backups: continuous WAL archiving + daily base backup to Wasabi S3, 30-day retention
- Endpoints: `postgres-rw.postgres.svc.cluster.local:5432`

**Extensions (pre-installed in `template1`, inherited by all tenant DBs):**

| Extension | Purpose |
|---|---|
| `pg_trgm` | Trigram fuzzy/partial text search |
| `unaccent` | Strip accents for multilingual search |
| `citext` | Case-insensitive text type |
| `pgcrypto` | UUID generation, hashing |
| `btree_gin` | GIN indexes on scalar types |
| `btree_gist` | GiST indexes on scalar types |
| `intarray` | Fast integer array operations |
| `pg_stat_statements` | Query statistics and monitoring |
| `vector` | pgvector — vector similarity search |
| `diskann` | pgvectorscale — DiskANN index for large-scale vector search |

**PostgreSQL parameters:** `max_connections=600`, `shared_buffers=256MB`, `default_toast_compression=lz4`

**Rebuild the image** (after updating extensions or PG version):
```bash
POSTGRES_IMAGE=dotcms/cnpg-postgresql:18 ./scripts/build-postgres.sh --push
```

## OpenSearch

- 3-node cluster in `opensearch` namespace
- Per-tenant user scoped to `TENANT-ENV-*` indices
- Endpoint: `https://opensearch.opensearch.svc.cluster.local:9200`

## Shared Storage — S3 FUSE

- StorageClass `s3-fuse` via csi-s3 + geesefs
- ReadWriteMany — multiple pods can mount simultaneously
- Each tenant PVC gets its own S3 prefix (`TENANT/TENANT-ENV`)
- Backed by Wasabi (no egress fees)

## Monitoring

- Grafana: `https://observe.botcms.cloud` (routed by Caddy)
- Prometheus retention: 15d

```bash
# Get Grafana admin password
kubectl get secret -n monitoring kube-prometheus-stack-grafana \
  -o jsonpath='{.data.admin-password}' | base64 -d && echo
```

## Secrets Required (.env)

Copy `.env.example` → `.env` and fill in values. Source before any script.

| Variable | Purpose |
|---|---|
| `KUBECONFIG` | Path to kubeconfig (default: `./kubeconfig`) |
| `HCLOUD_TOKEN` | Hetzner Cloud API token (CCM + hetzner-k3s) |
| `HETZNER_DNS_TOKEN` | Hetzner DNS API token (configure-dns.sh) |
| `WASABI_ACCESS_KEY` | Wasabi S3 access key |
| `WASABI_SECRET_KEY` | Wasabi S3 secret key |
| `WASABI_REGION` | e.g. `us-east-1` |
| `WASABI_BUCKET` | Bucket for CNPG WAL + base backups |
| `WASABI_S3FUSE_BUCKET` | Bucket for dotCMS shared assets (csi-s3) |
| `WASABI_LOKI_BUCKET` | Bucket for Loki log storage |
| `ACME_EMAIL` | Let's Encrypt registration email (Caddy) |
| `BASE_DOMAIN` | Base domain, e.g. `botcms.cloud` |
| `CADDY_ADMIN_DOMAIN` | FQDN for Caddy admin API |
| `CADDY_ADMIN_USER` | BasicAuth user for Grafana/Headlamp via Caddy |
| `CADDY_ADMIN_PASSWORD` | BasicAuth password (bcrypt-hashed by install-caddy.sh) |
| `OPENSEARCH_ADMIN_USER` | OpenSearch admin user (default: `admin`) |
| `OPENSEARCH_ADMIN_PASSWORD` | OpenSearch admin password |
| `GRAFANA_ADMIN_PASSWORD` | Grafana admin password |
| `VALKEY_PASSWORD` | Optional Valkey auth password (blank = no auth) |
| `DOTCMS_IMAGE` | dotCMS image, e.g. `mirror.gcr.io/dotcms/dotcms:LTS-24.10` |

## Verification Scripts

After `deploy.sh`, run these to validate each component:

```bash
scripts/verify-core-components.sh     # Cilium, CoreDNS, metrics-server
scripts/verify-caddy-ingress.sh       # Caddy + webhook + on-demand TLS
scripts/verify-prometheus-targets.sh  # Prometheus scrape targets
scripts/verify-grafana.sh             # Grafana datasources + dashboards
scripts/verify-promtail.sh            # Promtail log shipping
scripts/verify-loki-datasource.sh     # Loki datasource in Grafana
scripts/verify-loki-ingestion.sh      # Loki multi-tenant log ingestion
scripts/verify-tenant-tls.sh          # TLS cert for a tenant subdomain
```
