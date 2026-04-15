/**
 * OpenSearch Security REST API client — in-cluster variant.
 *
 * The shell scripts use kubectl port-forward because they run outside the
 * cluster. When running inside the cluster, we can reach OpenSearch directly
 * at https://opensearch.opensearch.svc.cluster.local:9200.
 *
 * OpenSearch uses a self-signed TLS certificate, so we disable peer
 * verification (equivalent to curl -sk).
 */

import * as https from 'https';

// ---------------------------------------------------------------------------
// Configuration (read from environment at call time)
// ---------------------------------------------------------------------------
function osConfig() {
  const host =
    process.env.OPENSEARCH_HOST ??
    'opensearch.opensearch.svc.cluster.local';
  const port = parseInt(process.env.OPENSEARCH_PORT ?? '9200', 10);
  const adminUser = process.env.OPENSEARCH_ADMIN_USER ?? 'admin';
  const adminPass = process.env.OPENSEARCH_ADMIN_PASSWORD ?? '';
  return { host, port, adminUser, adminPass };
}

// ---------------------------------------------------------------------------
// Low-level HTTP helpers
// ---------------------------------------------------------------------------

/** Performs a GET against the OS Security API. Returns HTTP status code. */
async function osGet(path: string): Promise<number> {
  const { host, port, adminUser, adminPass } = osConfig();
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: host,
        port,
        path,
        method: 'GET',
        headers: {
          Authorization:
            'Basic ' +
            Buffer.from(`${adminUser}:${adminPass}`).toString('base64'),
        },
        rejectUnauthorized: false,
      },
      (res) => resolve(res.statusCode ?? 0),
    );
    req.on('error', reject);
    req.end();
  });
}

/** Performs a PUT against the OS Security API with a JSON payload.
 *  Skip-if-exists: returns early with 'skipped' when resource already exists (200). */
async function osPut(
  path: string,
  body: Record<string, unknown>,
  label: string,
): Promise<void> {
  const { host, port, adminUser, adminPass } = osConfig();

  // Idempotency check: if resource already exists (200), skip creation.
  const existingStatus = await osGet(path);
  if (existingStatus === 200) {
    console.log(`[opensearch] [skip] ${label} already exists`);
    return;
  }

  const bodyStr = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: host,
        port,
        path,
        method: 'PUT',
        headers: {
          Authorization:
            'Basic ' +
            Buffer.from(`${adminUser}:${adminPass}`).toString('base64'),
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
        rejectUnauthorized: false,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) {
            console.log(`[opensearch] [ok] ${label} created`);
            resolve();
          } else {
            reject(
              new Error(
                `[opensearch] PUT ${path} failed (HTTP ${res.statusCode}): ${data.slice(0, 200)}`,
              ),
            );
          }
        });
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

/** Creates an OpenSearch index if it does not already exist.
 *  Uses HEAD to check existence first (idempotent). */
async function osCreateIndex(
  indexName: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const { host, port, adminUser, adminPass } = osConfig();
  const path = `/${indexName}`;

  // HEAD check for existence
  const existsCode = await new Promise<number>((resolve, reject) => {
    const req = https.request(
      {
        hostname: host,
        port,
        path,
        method: 'HEAD',
        headers: {
          Authorization:
            'Basic ' +
            Buffer.from(`${adminUser}:${adminPass}`).toString('base64'),
        },
        rejectUnauthorized: false,
      },
      (res) => resolve(res.statusCode ?? 0),
    );
    req.on('error', reject);
    req.end();
  });

  if (existsCode === 200) {
    console.log(`[opensearch] [skip] index '${indexName}' already exists`);
    return;
  }

  const bodyStr = JSON.stringify(settings);

  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        hostname: host,
        port,
        path,
        method: 'PUT',
        headers: {
          Authorization:
            'Basic ' +
            Buffer.from(`${adminUser}:${adminPass}`).toString('base64'),
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
        rejectUnauthorized: false,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) {
            console.log(`[opensearch] [ok] index '${indexName}' created`);
            resolve();
          } else {
            reject(
              new Error(
                `[opensearch] PUT ${path} failed (HTTP ${res.statusCode}): ${data.slice(0, 200)}`,
              ),
            );
          }
        });
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

/** Deletes an OpenSearch index. Ignores 404. */
async function osDeleteIndex(indexName: string, label: string): Promise<void> {
  const { host, port, adminUser, adminPass } = osConfig();
  const path = `/${indexName}`;

  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        hostname: host,
        port,
        path,
        method: 'DELETE',
        headers: {
          Authorization:
            'Basic ' +
            Buffer.from(`${adminUser}:${adminPass}`).toString('base64'),
        },
        rejectUnauthorized: false,
      },
      (res) => {
        if (res.statusCode === 404) {
          console.log(`[opensearch] [skip] index '${label}' not found`);
          resolve();
          return;
        }
        res.resume();
        res.on('end', () => {
          console.log(`[opensearch] [ok] index '${label}' deleted (HTTP ${res.statusCode})`);
          resolve();
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Performs a DELETE against the OS Security API. Ignores 404. */
async function osDelete(path: string, label: string): Promise<void> {
  const { host, port, adminUser, adminPass } = osConfig();

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: host,
        port,
        path,
        method: 'DELETE',
        headers: {
          Authorization:
            'Basic ' +
            Buffer.from(`${adminUser}:${adminPass}`).toString('base64'),
        },
        rejectUnauthorized: false,
      },
      (res) => {
        if (res.statusCode === 404) {
          console.log(`[opensearch] [skip] ${label} not found`);
          resolve();
          return;
        }
        res.resume(); // consume body
        res.on('end', () => {
          console.log(`[opensearch] [ok] ${label} deleted (HTTP ${res.statusCode})`);
          resolve();
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// High-level OpenSearch provisioning operations (mirrors tenant-add.sh Step 4)
// ---------------------------------------------------------------------------

/** Provision OpenSearch resources for a tenant instance.
 *  Creates: action groups, user, role, role mapping.
 *  Returns the generated OS password. */
export async function provisionOpenSearch(instance: string, existingPassword?: string): Promise<string> {
  // Reuse existing password on retries so the secret and OS user stay in sync.
  const { randomBytes } = await import('crypto');
  const osPass = existingPassword ?? randomBytes(24).toString('base64url').slice(0, 32);
  const osUsername = `${instance}-os-user`;
  const osRole = `${instance}-role`;
  const osIndexPattern = `cluster_${instance}*`;

  // Action groups
  await osPut(
    `/_plugins/_security/api/actiongroups/${instance}-cluster`,
    {
      allowed_actions: [
        'cluster:monitor/health',
        'indices:data/write/bulk',
        'cluster:monitor/state',
        'cluster:monitor/nodes/stats',
        'indices:data/read/scroll',
        'indices:data/read/scroll/clear',
      ],
    },
    `action-group/${instance}-cluster`,
  );

  await osPut(
    `/_plugins/_security/api/actiongroups/${instance}-index`,
    { allowed_actions: ['indices_all', 'indices_monitor'] },
    `action-group/${instance}-index`,
  );

  await osPut(
    `/_plugins/_security/api/actiongroups/${instance}-all-indices`,
    {
      allowed_actions: [
        'indices:monitor/stats',
        'indices:monitor/settings/get',
        'indices:admin/aliases/get',
      ],
    },
    `action-group/${instance}-all-indices`,
  );

  // User
  await osPut(
    `/_plugins/_security/api/internalusers/${osUsername}`,
    {
      password: osPass,
      attributes: { 'dotcms.instance': instance },
    },
    `user/${osUsername}`,
  );

  // Role
  await osPut(
    `/_plugins/_security/api/roles/${osRole}`,
    {
      cluster_permissions: [`${instance}-cluster`],
      index_permissions: [
        {
          index_patterns: [osIndexPattern],
          allowed_actions: [`${instance}-index`],
        },
        {
          index_patterns: ['*'],
          allowed_actions: [`${instance}-all-indices`],
        },
      ],
    },
    `role/${osRole}`,
  );

  // Role mapping
  await osPut(
    `/_plugins/_security/api/rolesmapping/${osRole}`,
    { users: [osUsername] },
    `role-mapping/${osRole} → ${osUsername}`,
  );

  // Seed index — dotCMS will auto-create additional indices under the
  // cluster_${instance}* pattern, but we create the base index up front so
  // the role/permission grant is testable immediately and the tenant is
  // fully provisioned without waiting for the first dotCMS write.
  const seedIndex = `cluster_${instance}`;
  await osCreateIndex(seedIndex, {
    settings: {
      number_of_shards: 1,
      number_of_replicas: 1,
    },
  });

  return osPass;
}

// ---------------------------------------------------------------------------
// High-level OpenSearch teardown (mirrors tenant-remove.sh deprovision_instance)
// ---------------------------------------------------------------------------

export async function deprovisionOpenSearch(instance: string): Promise<void> {
  const osUser = `${instance}-os-user`;
  const osRole = `${instance}-role`;

  await osDelete(
    `/_plugins/_security/api/rolesmapping/${osRole}`,
    `role-mapping/${osRole}`,
  );
  await osDelete(`/_plugins/_security/api/roles/${osRole}`, `role/${osRole}`);
  await osDelete(
    `/_plugins/_security/api/internalusers/${osUser}`,
    `user/${osUser}`,
  );
  await osDelete(
    `/_plugins/_security/api/actiongroups/${instance}-cluster`,
    `action-group/${instance}-cluster`,
  );
  await osDelete(
    `/_plugins/_security/api/actiongroups/${instance}-index`,
    `action-group/${instance}-index`,
  );
  await osDelete(
    `/_plugins/_security/api/actiongroups/${instance}-all-indices`,
    `action-group/${instance}-all-indices`,
  );

  // Delete the seed index (and any wildcarded siblings are left to the
  // operator since tenant data may be archived; only the seed index is
  // deterministically known here).
  await osDeleteIndex(`cluster_${instance}`, `cluster_${instance}`);
}
