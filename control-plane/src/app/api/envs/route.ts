import { sql } from '@/db';
import type { CustomerEnv, CreateCustomerEnv } from '@/db/types';

// ---------------------------------------------------------------------------
// POST /api/envs — create a new customer_env record with deploy_status=pending
// ---------------------------------------------------------------------------
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ error: 'Request body must be a JSON object' }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const errors: string[] = [];

  // --- Required fields ---

  // org_key: FK references customer_org — accept alphanumeric (any case) and hyphens.
  // Always lowercased before storage / K8s use.
  if (!input.org_key || typeof input.org_key !== 'string') {
    errors.push('org_key is required and must be a string');
  } else if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(input.org_key as string)) {
    errors.push('org_key must be lowercase alphanumeric with optional hyphens (1–63 chars), starting and ending with a letter or number');
  }

  // env_key: same k8s DNS label rules as org_key
  if (!input.env_key || typeof input.env_key !== 'string') {
    errors.push('env_key is required and must be a string');
  } else if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(input.env_key as string)) {
    errors.push('env_key must be lowercase alphanumeric only (a-z, 0-9), 1–63 characters, no hyphens or special characters');
  }

  // image: must be a non-empty string
  if (!input.image || typeof input.image !== 'string') {
    errors.push('image is required and must be a non-empty string');
  }

  // --- Optional fields with type checks ---

  if (input.cluster_id !== undefined && typeof input.cluster_id !== 'string') {
    errors.push('cluster_id must be a string');
  }

  if (input.region_id !== undefined && typeof input.region_id !== 'string') {
    errors.push('region_id must be a string');
  }

  if (input.replicas !== undefined) {
    const r = Number(input.replicas);
    if (!Number.isInteger(r) || r < 0 || r > 100) {
      errors.push('replicas must be an integer between 0 and 100');
    }
  }

  if (input.memory_req !== undefined && typeof input.memory_req !== 'string') {
    errors.push('memory_req must be a string (e.g. 4Gi)');
  }

  if (input.memory_limit !== undefined && typeof input.memory_limit !== 'string') {
    errors.push('memory_limit must be a string (e.g. 5Gi)');
  }

  if (input.cpu_req !== undefined && typeof input.cpu_req !== 'string') {
    errors.push('cpu_req must be a string (e.g. 500m)');
  }

  if (input.cpu_limit !== undefined && typeof input.cpu_limit !== 'string') {
    errors.push('cpu_limit must be a string (e.g. 2000m)');
  }

  if (input.env_vars !== undefined) {
    if (typeof input.env_vars !== 'object' || Array.isArray(input.env_vars) || input.env_vars === null) {
      errors.push('env_vars must be a JSON object (string → string map)');
    } else {
      const evMap = input.env_vars as Record<string, unknown>;
      for (const [k, v] of Object.entries(evMap)) {
        if (typeof v !== 'string') {
          errors.push(`env_vars["${k}"] must be a string`);
        }
      }
    }
  }

  if (input.stop_date !== undefined && input.stop_date !== null) {
    if (typeof input.stop_date !== 'string') {
      errors.push('stop_date must be an ISO-8601 timestamp string or null');
    } else if (isNaN(Date.parse(input.stop_date))) {
      errors.push('stop_date must be a valid ISO-8601 timestamp (e.g. 2026-06-01T00:00:00Z)');
    }
  }

  if (errors.length > 0) {
    return Response.json({ error: 'Validation failed', details: errors }, { status: 422 });
  }

  // Build the payload with defaults matching the DB schema defaults
  const payload: {
    org_key: string; env_key: string; image: string;
    cluster_id: string; region_id: string; replicas: number;
    memory_req: string; memory_limit: string; cpu_req: string; cpu_limit: string;
    env_vars: Record<string, string>; stop_date: string | null;
  } = {
    org_key:      (input.org_key as string).toLowerCase(),
    env_key:      (input.env_key as string).toLowerCase(),
    image:        input.image as string,
    cluster_id:   typeof input.cluster_id === 'string' ? input.cluster_id : 'default',
    region_id:    typeof input.region_id  === 'string' ? input.region_id  : 'ash',
    replicas:     input.replicas !== undefined ? Number(input.replicas) : 1,
    memory_req:   typeof input.memory_req   === 'string' ? input.memory_req   : '4Gi',
    memory_limit: typeof input.memory_limit === 'string' ? input.memory_limit : '5Gi',
    cpu_req:      typeof input.cpu_req      === 'string' ? input.cpu_req      : '500m',
    cpu_limit:    typeof input.cpu_limit    === 'string' ? input.cpu_limit    : '2000m',
    env_vars:     (input.env_vars as Record<string, string>) ?? {},
    stop_date:    typeof input.stop_date === 'string' ? input.stop_date : null,
  };

  try {
    const [created] = await sql<CustomerEnv[]>`
      INSERT INTO customer_env (
        org_key,
        env_key,
        cluster_id,
        region_id,
        image,
        replicas,
        memory_req,
        memory_limit,
        cpu_req,
        cpu_limit,
        env_vars,
        deploy_status,
        stop_date
      ) VALUES (
        ${payload.org_key},
        ${payload.env_key},
        ${payload.cluster_id},
        ${payload.region_id},
        ${payload.image},
        ${payload.replicas},
        ${payload.memory_req},
        ${payload.memory_limit},
        ${payload.cpu_req},
        ${payload.cpu_limit},
        ${sql.json(payload.env_vars)},
        'pending',
        ${payload.stop_date}
      )
      RETURNING *
    `;
    return Response.json(created, { status: 201 });
  } catch (err: unknown) {
    if (isPostgresError(err)) {
      // unique_violation: duplicate (org_key, env_key)
      if (err.code === '23505') {
        return Response.json(
          { error: `Environment '${payload.org_key}/${payload.env_key}' already exists` },
          { status: 409 }
        );
      }
      // foreign_key_violation: org_key doesn't exist in customer_org
      if (err.code === '23503') {
        return Response.json(
          { error: `Organization '${payload.org_key}' does not exist` },
          { status: 422 }
        );
      }
    }
    console.error('[POST /api/envs] Database error:', err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// GET /api/envs — list customer_env records with optional filtering
//
// Query parameters (all optional):
//   ?q=<term>        — unified search: matches org_key OR env_key
//                      (case-insensitive substring match on both columns)
//   ?org_key=<key>   — legacy: exact match on org_key (still supported)
//   ?name=<pattern>  — legacy: wildcard match on env_key (use * as wildcard)
// ---------------------------------------------------------------------------
export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q');
  const orgFilter = searchParams.get('org_key');
  const nameFilter = searchParams.get('name');

  try {
    let envs: CustomerEnv[];
    console.log("got query" + q)
    if (q !== null) {
      // Unified search: matches org_key OR env_key (substring, case-insensitive)
      // Escape ILIKE metacharacters so user input like '%' or '_' is treated literally
      const escaped = q.replace(/[\\%_]/g, '\\$&');
      const pattern = `%${escaped}%`;
      envs = await sql<CustomerEnv[]>`
        SELECT * FROM customer_env
        WHERE org_key ILIKE ${pattern}
           OR env_key ILIKE ${pattern}
        ORDER BY org_key, env_key ASC
      `;
    } else if (orgFilter !== null && nameFilter !== null) {
      const namePattern = nameFilter.replace(/\*/g, '%');
      envs = await sql<CustomerEnv[]>`
        SELECT * FROM customer_env
        WHERE org_key = ${orgFilter}
          AND env_key ILIKE ${namePattern}
        ORDER BY org_key, env_key ASC
      `;
    } else if (orgFilter !== null) {
      envs = await sql<CustomerEnv[]>`
        SELECT * FROM customer_env
        WHERE org_key = ${orgFilter}
        ORDER BY org_key, env_key ASC
      `;
    } else if (nameFilter !== null) {
      const namePattern = nameFilter.replace(/\*/g, '%');
      envs = await sql<CustomerEnv[]>`
        SELECT * FROM customer_env
        WHERE env_key ILIKE ${namePattern}
        ORDER BY org_key, env_key ASC
      `;
    } else {
      envs = await sql<CustomerEnv[]>`
        SELECT * FROM customer_env
        ORDER BY org_key, env_key ASC
      `;
    }

    return Response.json(envs);
  } catch (err) {
    console.error('[GET /api/envs] Database error:', err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
interface PostgresError {
  code: string;
  message: string;
}

function isPostgresError(err: unknown): err is PostgresError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as Record<string, unknown>).code === 'string'
  );
}
