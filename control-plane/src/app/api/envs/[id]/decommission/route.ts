import { sql } from '@/db';
import type { CustomerEnv } from '@/db/types';

// ---------------------------------------------------------------------------
// PATCH /api/envs/[id]/decommission
//
// Sets dcomm_date = NOW() for an environment, causing the polling worker to
// execute full teardown (namespace deletion, DB/role drop, S3 cleanup) on the
// next poll cycle once dcomm_date has elapsed.
//
// Supports any non-decommissioned state — operators can schedule teardown for
// deployed, stopped, or failed environments.  Returns 409 if the environment
// is already decommissioned.
//
// Route params:
//   id  — the org_key for the environment's parent organization
//
// Query params:
//   env_key  (required) — the environment key within the organization
//
// Example:
//   PATCH /api/envs/acme/decommission?env_key=prod
// ---------------------------------------------------------------------------

export async function PATCH(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id: org_key } = await params;
  const { searchParams } = new URL(_request.url);
  const env_key = searchParams.get('env_key');

  if (!org_key) {
    return Response.json({ error: 'org_key path parameter is required' }, { status: 400 });
  }

  if (!env_key) {
    return Response.json({ error: 'env_key query parameter is required' }, { status: 400 });
  }

  try {
    // Atomically set dcomm_date = NOW() only when not already decommissioned
    const [updated] = await sql<CustomerEnv[]>`
      UPDATE customer_env
      SET
        dcomm_date = NOW(),
        mod_date   = NOW()
      WHERE org_key       = ${org_key}
        AND env_key       = ${env_key}
        AND deploy_status != 'decommissioned'
      RETURNING *
    `;

    if (updated) {
      return Response.json(updated);
    }

    // Row didn't match — check whether it exists at all vs already decommissioned
    const [env] = await sql<Pick<CustomerEnv, 'org_key' | 'env_key' | 'deploy_status'>[]>`
      SELECT org_key, env_key, deploy_status
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

    return Response.json(
      {
        error: `Environment '${org_key}/${env_key}' is already decommissioned`,
        detail: `deploy_status is '${env.deploy_status}'`,
      },
      { status: 409 }
    );
  } catch (err) {
    console.error(`[PATCH /api/envs/${org_key}/decommission?env_key=${env_key}] Database error:`, err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST is an alias for PATCH — both set dcomm_date = NOW().
// Exposed as POST per the provisioning API contract (AC 110102).
export { PATCH as POST };
