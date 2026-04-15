import { sql } from '@/db';
import type { CustomerOrg, CustomerEnv } from '@/db/types';
import { requireApiAuth } from '@/lib/api-auth';

// ---------------------------------------------------------------------------
// POST /api/provision — create an org + environment in a single atomic call
//
// Creates the org if it doesn't already exist (upsert-style), then creates
// the environment. Both operations run in a transaction — if the env insert
// fails, the org insert is also rolled back.
//
// Body:
//   {
//     org: { org_key, org_long_name, org_email_domain?, org_data? },
//     env: { env_key, image, replicas?, memory_req?, memory_limit?,
//            cpu_req?, cpu_limit?, env_vars?, region_id?, cluster_id? }
//   }
//
// Auth: Bearer <API_TOKEN> or valid NextAuth session
// ---------------------------------------------------------------------------
export async function POST(request: Request): Promise<Response> {
  const authError = await requireApiAuth(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ error: 'Request body must be a JSON object' }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const errors: string[] = [];

  // ── Validate org fields ──────────────────────────────────────────────────
  const orgInput = input.org as Record<string, unknown> | undefined;
  if (!orgInput || typeof orgInput !== 'object') {
    errors.push('org is required and must be an object');
  } else {
    if (!orgInput.org_key || typeof orgInput.org_key !== 'string') {
      errors.push('org.org_key is required');
    } else if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(orgInput.org_key as string)) {
      errors.push('org.org_key must be lowercase letters, numbers, and hyphens (1–63 chars)');
    }
    if (!orgInput.org_long_name || typeof orgInput.org_long_name !== 'string') {
      errors.push('org.org_long_name is required');
    }
  }

  // ── Validate env fields ──────────────────────────────────────────────────
  const envInput = input.env as Record<string, unknown> | undefined;
  if (!envInput || typeof envInput !== 'object') {
    errors.push('env is required and must be an object');
  } else {
    if (!envInput.env_key || typeof envInput.env_key !== 'string') {
      errors.push('env.env_key is required');
    } else if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(envInput.env_key as string)) {
      errors.push('env.env_key must be lowercase letters, numbers, and hyphens (1–63 chars)');
    }
    if (!envInput.image || typeof envInput.image !== 'string') {
      errors.push('env.image is required');
    }
  }

  if (errors.length > 0) {
    return Response.json({ error: 'Validation failed', details: errors }, { status: 422 });
  }

  const orgKey = (orgInput!.org_key as string).toLowerCase();
  const envKey = (envInput!.env_key as string).toLowerCase();

  // ── Execute in a transaction ─────────────────────────────────────────────
  try {
    const result = await sql.begin(async (tx) => {
      // Upsert org — insert if not exists, update long_name if already exists
      const [org] = await tx<CustomerOrg[]>`
        INSERT INTO customer_org (org_key, org_long_name, org_active, org_email_domain, org_data)
        VALUES (
          ${orgKey},
          ${orgInput!.org_long_name as string},
          ${typeof orgInput!.org_active === 'boolean' ? orgInput!.org_active : true},
          ${orgInput!.org_email_domain ? (orgInput!.org_email_domain as string).toLowerCase() : ''},
          ${JSON.stringify((orgInput!.org_data as Record<string, unknown>) ?? {})}
        )
        ON CONFLICT (org_key) DO UPDATE
          SET org_long_name = EXCLUDED.org_long_name,
              mod_date      = NOW()
        RETURNING *
      `;

      // Insert environment
      const [env] = await tx<CustomerEnv[]>`
        INSERT INTO customer_env (
          org_key, env_key, cluster_id, region_id, image,
          replicas, memory_req, memory_limit, cpu_req, cpu_limit,
          env_vars, deploy_status
        ) VALUES (
          ${orgKey},
          ${envKey},
          ${typeof envInput!.cluster_id === 'string' ? envInput!.cluster_id : 'default'},
          ${typeof envInput!.region_id === 'string' ? envInput!.region_id : 'ash'},
          ${envInput!.image as string},
          ${envInput!.replicas !== undefined ? Number(envInput!.replicas) : 1},
          ${typeof envInput!.memory_req === 'string' ? envInput!.memory_req : '4Gi'},
          ${typeof envInput!.memory_limit === 'string' ? envInput!.memory_limit : '5Gi'},
          ${typeof envInput!.cpu_req === 'string' ? envInput!.cpu_req : '500m'},
          ${typeof envInput!.cpu_limit === 'string' ? envInput!.cpu_limit : '2000m'},
          ${JSON.stringify((envInput!.env_vars as Record<string, string>) ?? {})},
          'pending'
        )
        RETURNING *
      `;

      return { org, env };
    });

    return Response.json(result, { status: 201 });
  } catch (err: unknown) {
    if (isPostgresError(err)) {
      if (err.code === '23505') {
        return Response.json(
          { error: `Environment '${orgKey}/${envKey}' already exists` },
          { status: 409 }
        );
      }
    }
    console.error('[POST /api/provision] Database error:', err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

interface PostgresError { code: string; message: string }
function isPostgresError(err: unknown): err is PostgresError {
  return typeof err === 'object' && err !== null && 'code' in err &&
    typeof (err as Record<string, unknown>).code === 'string';
}
