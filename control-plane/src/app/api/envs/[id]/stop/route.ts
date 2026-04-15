import { sql } from '@/db';
import type { CustomerEnv } from '@/db/types';

// ---------------------------------------------------------------------------
// PATCH /api/envs/[id]/stop
//
// Sets replicas = 0 and stop_date = NOW().
//
// The replica change is detected as config drift on the next worker poll cycle,
// which patches the Kubernetes Deployment to 0. stop_date drives the
// effectiveStatus() display in the UI so operators see "stopping" immediately.
//
// Accepted from any active state except: decommissioning, decommissioned.
//
// Route params:
//   id  — the org_key for the environment's parent organization
//
// Query params:
//   env_key  (required) — the environment key within the organization
//
// Example:
//   PATCH /api/envs/acme/stop?env_key=prod
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
    // Set replicas = 0 (drift detection triggers the K8s patch) and
    // stop_date = NOW() (drives immediate UI status display).
    const [updated] = await sql<CustomerEnv[]>`
      UPDATE customer_env
      SET
        replicas  = 0,
        stop_date = NOW(),
        mod_date  = NOW()
      WHERE org_key      = ${org_key}
        AND env_key      = ${env_key}
        AND deploy_status NOT IN ('decommissioning', 'decommissioned')
      RETURNING *
    `;

    if (updated) {
      return Response.json(updated);
    }

    // Row didn't match — check whether it exists vs already in terminal state
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
      { error: `Environment '${org_key}/${env_key}' cannot be stopped: already ${env.deploy_status}` },
      { status: 409 }
    );
  } catch (err) {
    console.error(`[PATCH /api/envs/${org_key}/stop?env_key=${env_key}] Database error:`, err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
