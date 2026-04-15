/**
 * Kubernetes resource templates — TypeScript equivalents of the envsubst YAML
 * templates in /hetzner-k3s/templates/. Each function returns a plain object
 * (Record<string, unknown>) with the full K8s resource spec.
 *
 * KubernetesObject (the base type used by @kubernetes/client-node) only declares
 * apiVersion/kind/metadata. Extra fields like `spec`, `data`, `stringData`, and
 * `type` are not on that interface, so we return Record<string, unknown> here
 * and cast to KubernetesObject in applyObject()/deleteObject().
 *
 * Variable naming mirrors tenant-add.sh:
 *   TENANT_ID → org_key  (namespace)
 *   ENV_ID    → env_key
 *   INSTANCE  → org_key-env_key
 */

type K8sSpec = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Step 1 — Namespace + ResourceQuota + LimitRange
// ---------------------------------------------------------------------------

export function namespaceSpec(tenantId: string): K8sSpec {
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: tenantId,
      labels: { 'botcms.cloud/tenant': tenantId },
    },
  };
}

export function resourceQuotaSpec(tenantId: string): K8sSpec {
  return {
    apiVersion: 'v1',
    kind: 'ResourceQuota',
    metadata: { name: 'tenant-quota', namespace: tenantId },
    spec: {
      hard: {
        'requests.cpu': '20',
        'requests.memory': '80Gi',
        'limits.memory': '100Gi',
        pods: '30',
        services: '20',
        persistentvolumeclaims: '10',
      },
    },
  };
}

export function limitRangeSpec(tenantId: string): K8sSpec {
  return {
    apiVersion: 'v1',
    kind: 'LimitRange',
    metadata: { name: 'tenant-limits', namespace: tenantId },
    spec: {
      limits: [
        {
          type: 'Container',
          defaultRequest: { cpu: '100m', memory: '256Mi' },
          default: { cpu: '2', memory: '5Gi' },
          max: { cpu: '4', memory: '6Gi' },
          min: { cpu: '50m', memory: '64Mi' },
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Step 2 — Valkey ExternalName Service + connection Secret
// ---------------------------------------------------------------------------

export function valkeyServiceSpec(tenantId: string): K8sSpec {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: 'valkey',
      namespace: tenantId,
      labels: {
        'app.kubernetes.io/name': 'valkey',
        'app.kubernetes.io/managed-by': 'hetzner-k3s',
        'botcms.cloud/tenant': tenantId,
      },
    },
    spec: {
      type: 'ExternalName',
      externalName: 'valkey-master.valkey.svc.cluster.local',
      ports: [{ name: 'redis', port: 6379, protocol: 'TCP' }],
    },
  };
}

export function valkeySecretSpec(
  tenantId: string,
  instance: string,
  valkeyPassword: string,
): K8sSpec {
  const url = valkeyPassword
    ? `redis://:${valkeyPassword}@valkey-master.valkey.svc.cluster.local:6379`
    : 'redis://valkey-master.valkey.svc.cluster.local:6379';
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: `${instance}-valkey`,
      namespace: tenantId,
      labels: {
        'app.kubernetes.io/name': 'valkey',
        'app.kubernetes.io/managed-by': 'hetzner-k3s',
        'botcms.cloud/tenant': tenantId,
        'botcms.cloud/instance': instance,
      },
    },
    type: 'Opaque',
    stringData: {
      host: 'valkey-master.valkey.svc.cluster.local',
      port: '6379',
      password: valkeyPassword,
      url,
    },
  };
}

// ---------------------------------------------------------------------------
// Step 3 — Wasabi backup credentials Secret
// ---------------------------------------------------------------------------

export function wasabiBackupSecretSpec(
  tenantId: string,
  accessKey: string,
  secretKey: string,
): K8sSpec {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'wasabi-backup-creds', namespace: tenantId },
    type: 'Opaque',
    stringData: {
      ACCESS_KEY_ID: accessKey,
      ACCESS_SECRET_KEY: secretKey,
    },
  };
}

// ---------------------------------------------------------------------------
// Step 4 — OpenSearch credentials Secret (after OS API provisioning)
// ---------------------------------------------------------------------------

export function opensearchSecretSpec(
  tenantId: string,
  instance: string,
  osUsername: string,
  osPassword: string,
): K8sSpec {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: `${instance}-os-creds`,
      namespace: tenantId,
      labels: {
        'app.kubernetes.io/managed-by': 'hetzner-k3s',
        'botcms.cloud/tenant': tenantId,
        'botcms.cloud/instance': instance,
      },
    },
    type: 'Opaque',
    stringData: {
      username: osUsername,
      password: osPassword,
      host: 'opensearch.opensearch.svc.cluster.local',
      port: '9200',
      index_prefix: `cluster_${instance}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Step 5 — PostgreSQL credentials Secret
// ---------------------------------------------------------------------------

export function postgresSecretSpec(
  tenantId: string,
  instance: string,
  pgPass: string,
): K8sSpec {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: `${instance}-postgres`,
      namespace: tenantId,
      labels: {
        'app.kubernetes.io/managed-by': 'hetzner-k3s',
        'botcms.cloud/tenant': tenantId,
        'botcms.cloud/instance': instance,
      },
    },
    type: 'Opaque',
    stringData: {
      host: 'postgres-rw.postgres.svc.cluster.local',
      port: '5432',
      database: instance,
      username: instance,
      password: pgPass,
    },
  };
}

// ---------------------------------------------------------------------------
// Step 6 — S3-backed PersistentVolume + PersistentVolumeClaim
// ---------------------------------------------------------------------------

export function persistentVolumeSpec(
  tenantId: string,
  instance: string,
  bucket: string,
  storageSize: string,
): K8sSpec {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: {
      name: `${instance}-assets`,
      labels: {
        'botcms.cloud/tenant': tenantId,
        'botcms.cloud/instance': instance,
      },
    },
    spec: {
      capacity: { storage: storageSize },
      accessModes: ['ReadWriteMany'],
      persistentVolumeReclaimPolicy: 'Retain',
      storageClassName: 's3-fuse',
      claimRef: { namespace: tenantId, name: `${instance}-assets` },
      csi: {
        driver: 'ru.yandex.s3.csi',
        volumeHandle: `${bucket}/${tenantId}/${instance}`,
        volumeAttributes: {
          bucket,
          mounter: 'geesefs',
          options:
            '--cache /var/lib/geesefs-cache --memory-limit 5120 --dir-mode 0777 --file-mode 0666',
        },
        nodePublishSecretRef: { name: 'csi-s3-secret', namespace: 'kube-system' },
        nodeStageSecretRef: { name: 'csi-s3-secret', namespace: 'kube-system' },
      },
    },
  };
}

export function persistentVolumeClaimSpec(
  tenantId: string,
  instance: string,
  storageSize: string,
): K8sSpec {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: `${instance}-assets`,
      namespace: tenantId,
      labels: {
        'botcms.cloud/tenant': tenantId,
        'botcms.cloud/instance': instance,
      },
    },
    spec: {
      accessModes: ['ReadWriteMany'],
      storageClassName: 's3-fuse',
      volumeName: `${instance}-assets`,
      resources: { requests: { storage: storageSize } },
    },
  };
}

// ---------------------------------------------------------------------------
// Step 7 — dotCMS Deployment, HPA, PDB, ClusterIP Service, Headless Service
// ---------------------------------------------------------------------------

export interface DotcmsDeploymentParams {
  tenantId: string;
  instance: string;
  image: string;
  replicas: number;
  cpuReq: string;
  memReq: string;
  memLimit: string;
}

export function dotcmsDeploymentSpec(p: DotcmsDeploymentParams): K8sSpec {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: p.instance,
      namespace: p.tenantId,
      labels: {
        'app.kubernetes.io/name': 'dotcms',
        'app.kubernetes.io/instance': p.instance,
        'botcms.cloud/tenant': p.tenantId,
        'botcms.cloud/instance': p.instance,
      },
    },
    spec: {
      replicas: p.replicas,
      minReadySeconds: 30,
      selector: { matchLabels: { app: 'dotcms', instance: p.instance } },
      strategy: {
        type: 'RollingUpdate',
        rollingUpdate: { maxSurge: 1, maxUnavailable: 0 },
      },
      template: {
        metadata: {
          labels: {
            app: 'dotcms',
            instance: p.instance,
            'botcms.cloud/tenant': p.tenantId,
            'botcms.cloud/instance': p.instance,
          },
        },
        spec: {
          terminationGracePeriodSeconds: 60,
          containers: [
            {
              name: 'dotcms',
              image: p.image,
              imagePullPolicy: 'Always',
              resources: {
                requests: { cpu: p.cpuReq, memory: p.memReq },
                limits: { memory: p.memLimit },
              },
              env: [
                { name: 'JAVA_OPTS_MEMORY', value: '-XX:MaxRAMPercentage=66' },
                {
                  name: 'CMS_JAVA_OPTS',
                  value: '-Dlog4j2.formatMsgNoLookups=true -XX:+UseG1GC -XX:-UseZGC',
                },
                { name: 'CMS_DISABLE_APR_SSL', value: 'true' },
                { name: 'CMS_SSL_ENABLED', value: 'false' },
                { name: 'DOT_DOTCMS_CLUSTER_ID', value: p.instance },
                {
                  name: 'DB_BASE_URL',
                  value: `jdbc:postgresql://postgres-rw.postgres.svc.cluster.local:5432/${p.instance}`,
                },
                {
                  name: 'DB_USERNAME',
                  valueFrom: {
                    secretKeyRef: { name: `${p.instance}-postgres`, key: 'username' },
                  },
                },
                {
                  name: 'DB_PASSWORD',
                  valueFrom: {
                    secretKeyRef: { name: `${p.instance}-postgres`, key: 'password' },
                  },
                },
                { name: 'DOT_DB_MAX_TOTAL', value: '10' },
                { name: 'DOT_DB_MAX_IDLE', value: '5' },
                {
                  name: 'DOT_ES_ENDPOINTS',
                  value: 'https://opensearch.opensearch.svc.cluster.local:9200',
                },
                { name: 'DOT_ES_AUTH_TYPE', value: 'BASIC' },
                {
                  name: 'DOT_ES_AUTH_BASIC_USER',
                  valueFrom: {
                    secretKeyRef: { name: `${p.instance}-os-creds`, key: 'username' },
                  },
                },
                {
                  name: 'DOT_ES_AUTH_BASIC_PASSWORD',
                  valueFrom: {
                    secretKeyRef: { name: `${p.instance}-os-creds`, key: 'password' },
                  },
                },
                {
                  name: 'DOT_REMOTE_CALL_SUBNET_BLACKLIST',
                  value: '169.254.169.254/32,127.0.0.1/32,172.16.0.0/12,192.168.0.0/16',
                },
                { name: 'DOT_SYSTEM_STATUS_API_IP_ACL', value: '0.0.0.0/0' },
              ],
              ports: [
                { containerPort: 8080, name: 'http' },
                { containerPort: 8082, name: 'https' },
              ],
              volumeMounts: [
                { name: 'assets', mountPath: '/data/shared' },
                { name: 'ssl-certs', mountPath: '/data/shared/assets/certs' },
              ],
              startupProbe: {
                httpGet: { path: '/api/v1/probes/heavy', port: 8082 },
                initialDelaySeconds: 30,
                periodSeconds: 10,
                successThreshold: 1,
                failureThreshold: 60,
                timeoutSeconds: 5,
              },
              livenessProbe: {
                httpGet: { path: '/api/v1/probes/light', port: 8082 },
                periodSeconds: 10,
                successThreshold: 1,
                failureThreshold: 3,
                timeoutSeconds: 10,
              },
              readinessProbe: {
                httpGet: { path: '/api/v1/probes/light', port: 8082 },
                periodSeconds: 15,
                successThreshold: 1,
                failureThreshold: 6,
                timeoutSeconds: 10,
              },
            },
          ],
          volumes: [
            {
              name: 'assets',
              persistentVolumeClaim: { claimName: `${p.instance}-assets` },
            },
            { name: 'ssl-certs', emptyDir: {} },
          ],
          tolerations: [
            {
              key: 'node.kubernetes.io/server-usage',
              operator: 'Equal',
              value: 'dotcms',
              effect: 'NoSchedule',
            },
          ],
          affinity: {
            nodeAffinity: {
              preferredDuringSchedulingIgnoredDuringExecution: [
                {
                  weight: 100,
                  preference: {
                    matchExpressions: [
                      {
                        key: 'node.kubernetes.io/server-usage',
                        operator: 'In',
                        values: ['dotcms'],
                      },
                    ],
                  },
                },
              ],
            },
            podAntiAffinity: {
              requiredDuringSchedulingIgnoredDuringExecution: [
                {
                  labelSelector: {
                    matchExpressions: [
                      { key: 'instance', operator: 'In', values: [p.instance] },
                    ],
                  },
                  topologyKey: 'kubernetes.io/hostname',
                },
              ],
            },
          },
        },
      },
    },
  };
}

export function dotcmsPdbSpec(tenantId: string, instance: string): K8sSpec {
  return {
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: {
      name: instance,
      namespace: tenantId,
      labels: {
        'botcms.cloud/tenant': tenantId,
        'botcms.cloud/instance': instance,
      },
    },
    spec: {
      maxUnavailable: 1,
      selector: { matchLabels: { app: 'dotcms', instance } },
    },
  };
}

export function dotcmsHpaSpec(tenantId: string, instance: string): K8sSpec {
  return {
    apiVersion: 'autoscaling/v2',
    kind: 'HorizontalPodAutoscaler',
    metadata: {
      name: instance,
      namespace: tenantId,
      labels: {
        'botcms.cloud/tenant': tenantId,
        'botcms.cloud/instance': instance,
      },
    },
    spec: {
      scaleTargetRef: {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        name: instance,
      },
      minReplicas: 1,
      maxReplicas: 6,
      metrics: [
        {
          type: 'Resource',
          resource: {
            name: 'cpu',
            target: { type: 'Utilization', averageUtilization: 70 },
          },
        },
      ],
      behavior: {
        scaleUp: {
          stabilizationWindowSeconds: 60,
          policies: [{ type: 'Pods', value: 1, periodSeconds: 60 }],
        },
        scaleDown: {
          stabilizationWindowSeconds: 300,
          policies: [{ type: 'Pods', value: 1, periodSeconds: 120 }],
        },
      },
    },
  };
}

export function dotcmsClusterIpServiceSpec(tenantId: string, instance: string): K8sSpec {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: instance,
      namespace: tenantId,
      labels: {
        'app.kubernetes.io/name': 'dotcms',
        'app.kubernetes.io/instance': instance,
        'botcms.cloud/tenant': tenantId,
        'botcms.cloud/instance': instance,
      },
    },
    spec: {
      selector: { app: 'dotcms', instance },
      ports: [{ name: 'http', port: 80, targetPort: 8082 }],
    },
  };
}

export function dotcmsHeadlessServiceSpec(tenantId: string, instance: string): K8sSpec {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: `${instance}-hl`,
      namespace: tenantId,
      labels: {
        'app.kubernetes.io/name': 'dotcms',
        'app.kubernetes.io/instance': instance,
        'botcms.cloud/tenant': tenantId,
        'botcms.cloud/instance': instance,
      },
    },
    spec: {
      clusterIP: 'None',
      selector: { app: 'dotcms', instance },
      ports: [{ name: 'http', port: 80, targetPort: 8082 }],
    },
  };
}

// ---------------------------------------------------------------------------
// Step 8 — Ingress routing declaration
// ---------------------------------------------------------------------------

export function ingressSpec(
  tenantId: string,
  instance: string,
  baseDomain: string,
): K8sSpec {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: instance,
      namespace: tenantId,
      labels: {
        'app.kubernetes.io/name': 'dotcms',
        'app.kubernetes.io/instance': instance,
        'app.kubernetes.io/managed-by': 'tenant-add',
        'botcms.cloud/tenant': tenantId,
        'botcms.cloud/instance': instance,
      },
      annotations: {
        'botcms.cloud/routing': 'cname_router',
        'botcms.cloud/hostname': `${instance}.${baseDomain}`,
        'botcms.cloud/headless-svc': `${instance}-hl`,
      },
    },
    spec: {
      ingressClassName: 'caddy',
      rules: [
        {
          host: `${instance}.${baseDomain}`,
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: {
                  service: { name: instance, port: { number: 80 } },
                },
              },
            ],
          },
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Step 9 — CaddyRoute ConfigMap catalog entry
// ---------------------------------------------------------------------------

export function caddyRouteSpec(
  tenantId: string,
  instance: string,
  baseDomain: string,
): K8sSpec {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: `route-${instance}`,
      namespace: 'caddy-ingress',
      labels: {
        'app.kubernetes.io/managed-by': 'tenant-add',
        'botcms.cloud/type': 'caddy-route',
        'botcms.cloud/tenant': tenantId,
        'botcms.cloud/instance': instance,
      },
      annotations: {
        'botcms.cloud/hostname': `${instance}.${baseDomain}`,
        'botcms.cloud/headless-svc': `${instance}-hl.${tenantId}.svc.cluster.local`,
        'botcms.cloud/clusterip-svc': `${instance}.${tenantId}.svc.cluster.local`,
      },
    },
    data: {
      tenant: tenantId,
      instance,
      hostname: `${instance}.${baseDomain}`,
      'headless-svc': `${instance}-hl.${tenantId}.svc.cluster.local`,
      'clusterip-svc': `${instance}.${tenantId}.svc.cluster.local`,
      'service-port': '8082',
      'cookie-name': 'lb_session',
    },
  };
}
