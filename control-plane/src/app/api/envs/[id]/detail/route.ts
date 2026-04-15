import { sql } from '@/db';
import type { CustomerEnv } from '@/db/types';

// ---------------------------------------------------------------------------
// GET /api/envs/[id]/detail
//
// Returns the full customer_env record for a given org+env pair.
//
// Route params:
//   id  — the org_key for the environment's parent organization
//
// Query params:
//   env_key  (required) — the environment key within the organization
//
// Example:
//   GET /api/envs/acme/detail?env_key=prod
// ---------------------------------------------------------------------------
//
// PATCH /api/envs/[id]/detail?env_key=xxx
//
// Updates mutable configuration fields on a customer_env record.
// Non-mutable fields (org_key, env_key, cluster_id, region_id, deploy_status,
// *_date timestamps) are silently ignored.
//
// Accepted body fields (all optional):
//   image        — Docker image reference string
//   replicas     — positive integer
//   memory_req   — Kubernetes quantity string (e.g. "512Mi")
//   memory_limit — Kubernetes quantity string
//   cpu_req      — Kubernetes quantity string (e.g. "250m")
//   cpu_limit    — Kubernetes quantity string
//   env_vars     — Record<string, string> of environment variable overrides
//
// Returns the updated customer_env row on success.
// ---------------------------------------------------------------------------

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id: org_key } = await params;
  const { searchParams } = new URL(request.url);
  const env_key = searchParams.get('env_key');

  if (!org_key || typeof org_key !== 'string') {
    return Response.json(
      { error: 'org_key path parameter is required' },
      { status: 400 }
    );
  }

  if (!env_key) {
    return Response.json(
      { error: 'env_key query parameter is required' },
      { status: 400 }
    );
  }

  try {
    const [env] = await sql<CustomerEnv[]>`
      SELECT *
      FROM customer_env
      WHERE org_key = ${org_key}
        AND env_key = ${env_key}
    `;

    if (!env) {
      return Response.json(
        { error: `Environment '${org_key}/${env_key}' not found` },
        { status: 404 }
      );
    }

    // Normalize env_vars — postgres.js may return JSONB as a string in some configurations
    const normalized = {
      ...env,
      env_vars: typeof env.env_vars === 'string'
        ? JSON.parse(env.env_vars)
        : (env.env_vars ?? {}),
    };
    return Response.json(normalized);
  } catch (err) {
    console.error(
      `[GET /api/envs/${org_key}/detail?env_key=${env_key}] Database error:`,
      err
    );
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PATCH handler
// ---------------------------------------------------------------------------

interface PatchBody {
  image?: string;
  replicas?: number;
  memory_req?: string;
  memory_limit?: string;
  cpu_req?: string;
  cpu_limit?: string;
  env_vars?: Record<string, string>;
  /** ISO-8601 timestamp to schedule a stop, or null to clear */
  stop_date?: string | null;
  /** ISO-8601 timestamp to schedule decommission, or null to clear */
  dcomm_date?: string | null;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id: org_key } = await params;
  const { searchParams } = new URL(request.url);
  const env_key = searchParams.get('env_key');

  if (!org_key || typeof org_key !== 'string') {
    return Response.json(
      { error: 'org_key path parameter is required' },
      { status: 400 }
    );
  }

  if (!env_key) {
    return Response.json(
      { error: 'env_key query parameter is required' },
      { status: 400 }
    );
  }

  let body: PatchBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Request body must be valid JSON' }, { status: 400 });
  }

  // Validate replicas if provided
  if (body.replicas !== undefined) {
    const r = Number(body.replicas);
    if (!Number.isInteger(r) || r < 0) {
      return Response.json(
        { error: 'replicas must be a non-negative integer' },
        { status: 400 }
      );
    }
  }

  // Validate env_vars if provided
  if (body.env_vars !== undefined) {
    if (
      typeof body.env_vars !== 'object' ||
      Array.isArray(body.env_vars) ||
      body.env_vars === null
    ) {
      return Response.json(
        { error: 'env_vars must be a plain object (Record<string, string>)' },
        { status: 400 }
      );
    }
  }

  // Validate stop_date / dcomm_date if provided (non-null value must be valid ISO)
  for (const field of ['stop_date', 'dcomm_date'] as const) {
    const val = body[field];
    if (val !== undefined && val !== null) {
      if (typeof val !== 'string' || isNaN(Date.parse(val))) {
        return Response.json(
          { error: `${field} must be a valid ISO-8601 timestamp or null` },
          { status: 400 }
        );
      }
    }
  }

  try {
    // Check environment exists first
    const [existing] = await sql<Pick<CustomerEnv, 'org_key' | 'env_key'>[]>`
      SELECT org_key, env_key
      FROM customer_env
      WHERE org_key = ${org_key}
        AND env_key = ${env_key}
    `;

    if (!existing) {
      return Response.json(
        { error: `Environment '${org_key}/${env_key}' not found` },
        { status: 404 }
      );
    }

    // Build update — only touch fields that were provided
    const {
      image,
      replicas,
      memory_req,
      memory_limit,
      cpu_req,
      cpu_limit,
      env_vars,
      stop_date,
      dcomm_date,
    } = body;

    // For nullable date fields: undefined = don't touch, null = clear, string = set
    const stopDateVal = stop_date === undefined ? undefined : (stop_date ?? null);
    const dcommDateVal = dcomm_date === undefined ? undefined : (dcomm_date ?? null);

    const [updated] = await sql<CustomerEnv[]>`
      UPDATE customer_env
      SET
        image        = COALESCE(${image ?? null}, image),
        replicas     = COALESCE(${replicas !== undefined ? replicas : null}, replicas),
        memory_req   = COALESCE(${memory_req ?? null}, memory_req),
        memory_limit = COALESCE(${memory_limit ?? null}, memory_limit),
        cpu_req      = COALESCE(${cpu_req ?? null}, cpu_req),
        cpu_limit    = COALESCE(${cpu_limit ?? null}, cpu_limit),
        env_vars     = COALESCE(${env_vars !== undefined ? sql.json(env_vars) : null}, env_vars),
        stop_date    = CASE WHEN ${stopDateVal !== undefined} THEN ${stopDateVal ?? null}::timestamptz ELSE stop_date END,
        dcomm_date   = CASE WHEN ${dcommDateVal !== undefined} THEN ${dcommDateVal ?? null}::timestamptz ELSE dcomm_date END,
        mod_date     = NOW()
      WHERE org_key = ${org_key}
        AND env_key = ${env_key}
      RETURNING *
    `;

    return Response.json(updated);
  } catch (err) {
    console.error(
      `[PATCH /api/envs/${org_key}/detail?env_key=${env_key}] Database error:`,
      err
    );
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
