# caddy-cname-router

A Caddy plugin for multi-tenant custom domain routing on Kubernetes.

Two Caddy modules are provided:

| Module | ID | Purpose |
|--------|----|---------|
| HTTP middleware | `http.handlers.cname_router` | Routes incoming requests to the correct backend |
| TLS permission | `tls.permission.cname_router` | Gates on-demand certificate issuance |

---

## How routing works

Resolution is attempted in this order — first match wins:

### 1. Tenant lookup (headless service DNS)

For `*.botcms.cloud` subdomains or custom domains with a CNAME pointing to `*.botcms.cloud`, the plugin parses the subdomain as `<org>-<env>` and verifies the tenant exists by resolving its headless Kubernetes service:

```
customer.com  ──CNAME──▶  bigcorp-prod.botcms.cloud
                           │
                           ▼ subdomain = "bigcorp-prod"
                           ▼ splits right-to-left: tenant=bigcorp, env=prod
                           ▼ DNS check: bigcorp-prod-hl.bigcorp.svc.cluster.local
                           ▼ proxy to pod IP (sticky via lb_session cookie)
```

Hyphens in both `org_key` and `env_key` are supported. The plugin tries all right-to-left hyphen splits until one resolves in DNS:

```
big-corp-my-env  →  tries: big-corp / my-env  (wins if DNS resolves)
                    tries: big / corp-my-env
                    ...
```

### 2. ConfigMap lookup (internal / single-instance services)

If no tenant matches, the plugin queries the Kubernetes API for ConfigMaps in the `caddy-ingress` namespace labelled `botcms.cloud/type=caddy-route` whose `data.hostname` matches the incoming host. Traffic is proxied directly to `data.clusterip-svc:data.service-port`.

This enables routing to any internal service — control plane, dashboards, tooling — without modifying the Caddyfile. Simply drop a ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: route-control-plane
  namespace: caddy-ingress
  labels:
    botcms.cloud/type: caddy-route
  annotations:
    botcms.cloud/hostname: control.botcms.cloud
    botcms.cloud/clusterip-svc: control-plane.control-plane.svc.cluster.local
data:
  hostname: control.botcms.cloud
  clusterip-svc: control-plane.control-plane.svc.cluster.local
  service-port: "3000"
```

The registry is refreshed from the API every 30 seconds and cached in-memory.

---

## Forwarded headers

Both routing paths set:

| Header | Value |
|--------|-------|
| `X-Forwarded-For` | Client IP (appended automatically by `httputil.ReverseProxy`) |
| `X-Forwarded-Host` | Original `Host` header from the client |
| `X-Forwarded-Proto` | `https` when Caddy terminates TLS (almost always), otherwise falls back to any existing header or `http` |

---

## TLS certificate issuance

The `tls.permission.cname_router` module is used as the on-demand TLS permission gate. A certificate is issued if either:

1. The domain resolves to a known tenant via headless service DNS, **or**
2. The domain matches a `hostname` field in a `caddy-route` ConfigMap.

Any other domain is denied — no wildcard issuance.

---

## Caddyfile configuration

```caddyfile
{
    on_demand_tls {
        permission cname_router {
            base_domain botcms.cloud
        }
    }
}

:443 {
    tls { on_demand }

    route {
        cname_router {
            base_domain    botcms.cloud
            cookie_name    lb_session   # default
            service_port   8082         # default for tenant pods
            # separator         -       # default
            # cache_ttl         5m      # positive DNS cache
            # negative_cache_ttl 30s    # negative DNS cache
        }
        respond "not found" 404
    }
}

:80 {
    route {
        respond /health 200
        redir https://{host}{uri} permanent
    }
}
```

---

## Building

The image is built with [xcaddy](https://github.com/caddyserver/xcaddy) and includes the [caddy-storage-redis](https://github.com/pberkel/caddy-storage-redis) plugin for shared cert storage across replicas.

```bash
docker build --platform linux/amd64 -t dotcms/caddy-cname:latest .
docker push dotcms/caddy-cname:latest
```

---

## Kubernetes RBAC

The Caddy service account needs these permissions in addition to the defaults:

```yaml
- apiGroups: [""]
  resources: [configmaps]
  verbs: [get, list, watch]
```

This is required for the ConfigMap route registry. The ConfigMaps are read from the `caddy-ingress` namespace only.

---

## Sticky sessions

Tenant traffic uses pod-affinity sticky sessions via the `lb_session` cookie (configurable). The cookie value is the selected pod IP. On subsequent requests, if the IP is still in the pod list it is reused; otherwise a new pod is selected via FNV hash for consistent assignment.

Internal service traffic (ConfigMap routes) goes directly to the ClusterIP service — no sticky sessions needed since those services handle their own session state.
