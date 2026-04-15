# dotCMS Control Plane

Database-driven provisioning and lifecycle management for dotCMS tenant environments on Kubernetes, deployed at `https://control.botcms.cloud`.

## Stack

- **Next.js 16** (App Router, TypeScript, standalone output)
- **postgres.js** — raw SQL, no ORM
- **@kubernetes/client-node** — in-cluster kubeconfig
- **next-auth v5** — Google OAuth
- **Tailwind CSS 4 + DaisyUI 5** (light theme)

## Architecture

```
Browser ──▶ control.botcms.cloud (Caddy) ──▶ control-plane pod
                                                    │
                                          PostgreSQL (dotcms_cloud_control)
                                                    │
                                          Polling worker (30s loop)
                                                    │
                              ┌─────────────────────┼───────────────────┐
                              │                     │                   │
                           kubectl             direct SQL           OpenSearch
                        (K8s resources)       (PG role/db)         REST API
```

The polling worker runs as a Next.js instrumentation hook — starts automatically on boot, polls every 30 seconds.

PostgreSQL provisioning uses direct SQL via the `dotcms_control` role (no `kubectl exec`). The role must have `CREATEDB` and `CREATEROLE`. Tenant DBs are owned by the tenant role; `dotcms_control` is granted membership for decommission.

## Lifecycle State Machine

```
pending → provisioning → deployed
                       ↓
               reconfiguring  ──▶ deployed   (config drift detected)
               stopping       ──▶ stopped    (replicas set to 0)
               decommissioning ─▶ decommissioned (dcomm_date elapsed)
               * → failed  (retries exhausted — use retrigger to reset)
```

**Stop flow:** stop API sets `replicas=0` and `stop_date=NOW()`. The worker detects replica drift and patches the K8s deployment to 0.

**Restart flow:** edit settings → set replicas > 0 → worker detects drift → patches deployment back up.

**Drift detection:** `detectAndEnqueueReconfigs` checks both `deployed` and `stopped` envs. Rows where `mod_date <= last_applied_at` are skipped (no-op). Migration 006 adds the `last_applied_at` column — run migrations before deploying a new image.

**Kustomize base** is baked into the Docker image at `/app/kustomize/dotcms-base`.

## Environment Variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | `postgres://dotcms_control:<pw>@postgres-rw.postgres.svc.cluster.local:5432/dotcms_cloud_control` |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `AUTH_SECRET` | NextAuth signing secret — generate with `openssl rand -base64 32` |
| `AUTH_TRUST_HOST` | Set to `true` in production (behind Caddy reverse proxy) |
| `NEXTAUTH_URL` | `https://control.botcms.cloud` |
| `API_TOKEN` | Bearer token for machine-to-machine API calls |
| `OPENSEARCH_URL` | `https://opensearch-cluster-master.opensearch.svc.cluster.local:9200` |
| `OPENSEARCH_ADMIN_USER` | OpenSearch admin user |
| `OPENSEARCH_ADMIN_PASSWORD` | OpenSearch admin password |
| `BASE_DOMAIN` | e.g. `botcms.cloud` — used when generating tenant ingress/routes |
| `WASABI_ACCESS_KEY` | S3 access key for tenant PVC provisioning |
| `WASABI_SECRET_KEY` | S3 secret key |
| `WASABI_S3FUSE_BUCKET` | Bucket for dotCMS tenant assets |
| `VALKEY_PASSWORD` | Valkey auth password (optional, blank = no auth) |
| `WORKER_DISABLED` | Set to `true` in local dev to disable the polling worker |

For local dev, create `.env.local` with `WORKER_DISABLED=true` and a port-forwarded `DATABASE_URL`.

## Local Development

```bash
# Port-forward the CNPG cluster
kubectl port-forward -n postgres svc/postgres-rw 5432:5432

npm install
npm run dev       # http://localhost:3000
```

Google OAuth redirect URI for local dev: `http://localhost:3000/api/auth/callback/google`

## Running Migrations

```bash
DATABASE_URL=postgres://... npx tsx src/db/migrate.ts
```

Always run migrations before deploying a new image when a new migration is present.

## Running Tests

```bash
npm test           # run all
npm run test:watch # watch mode
```

## Production Deployment

### 1. Build and push the image

Build from the repo root (`hetzner-k3s/`), not from inside `control-plane/`:

```bash
docker build --platform linux/amd64 -t dotcms/trial-control-plane:latest -f control-plane/Dockerfile .
docker push dotcms/trial-control-plane:latest
```

### 2. Create namespace and secrets

```bash
kubectl apply -f kustomize/namespace.yaml

# Docker Hub pull secret
kubectl create secret docker-registry regcred \
  --docker-server=https://index.docker.io/v1/ \
  --docker-username=<user> \
  --docker-password=<token> \
  -n control-plane

# App secrets
kubectl create secret generic control-plane-secrets \
  --from-literal=DATABASE_URL='postgres://dotcms_control:<pw>@postgres-rw.postgres.svc.cluster.local:5432/dotcms_cloud_control' \
  --from-literal=AUTH_SECRET='<openssl rand -base64 32>' \
  --from-literal=AUTH_TRUST_HOST='true' \
  --from-literal=NEXTAUTH_URL='https://control.botcms.cloud' \
  --from-literal=API_TOKEN='<token>' \
  --from-literal=GOOGLE_CLIENT_ID='<id>' \
  --from-literal=GOOGLE_CLIENT_SECRET='<secret>' \
  --from-literal=OPENSEARCH_URL='https://opensearch-cluster-master.opensearch.svc.cluster.local:9200' \
  --from-literal=OPENSEARCH_ADMIN_USER='dotcms_admin' \
  --from-literal=OPENSEARCH_ADMIN_PASSWORD='<pw>' \
  -n control-plane
```

### 3. Run migrations

```bash
DATABASE_URL=postgres://dotcms_control:<pw>@localhost:5432/dotcms_cloud_control \
  npx tsx src/db/migrate.ts
```

### 4. Deploy

```bash
kubectl apply -k kustomize/
```

The CaddyRoute ConfigMap in `kustomize/caddy-route.yaml` registers `control.botcms.cloud` with Caddy automatically — no Caddyfile change needed.

### Updating

```bash
docker build --platform linux/amd64 -t dotcms/trial-control-plane:latest -f control-plane/Dockerfile .
docker push dotcms/trial-control-plane:latest
kubectl rollout restart deployment/control-plane -n control-plane
```

## API Routes

| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/orgs` | List / create organizations |
| PATCH/DELETE | `/api/orgs/[id]` | Update / delete organization |
| GET/POST | `/api/envs` | List / create environments |
| GET/PATCH | `/api/envs/[id]/detail` | Fetch / update environment config |
| GET | `/api/envs/[id]/status` | Live deploy status + recent logs |
| GET | `/api/envs/[id]/logs` | Full deployment log history |
| PATCH | `/api/envs/[id]/stop` | Schedule scale-to-zero |
| PATCH | `/api/envs/[id]/decommission` | Schedule full teardown |
| DELETE | `/api/envs/[id]/delete` | Delete (decommissions first if needed) |
| POST | `/api/envs/[id]/retrigger` | Reset failed env and re-queue |
| GET | `/api/envs/[id]/manifest` | Return generated kustomize manifest YAML |
| POST | `/api/provision` | Atomic org+env creation (machine-to-machine) |
| GET | `/api/health` | Health check |

Machine-to-machine calls require `Authorization: Bearer <API_TOKEN>`.
