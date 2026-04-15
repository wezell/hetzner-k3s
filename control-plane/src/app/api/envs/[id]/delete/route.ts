import { sql } from '@/db';
import type { CustomerEnv } from '@/db/types';
import { hardDeleteEnv } from '@/worker/db-worker';

// ---------------------------------------------------------------------------
// DELETE /api/envs/[id]/delete?env_key=xxx
//
// Deletes an environment record and all associated deployment logs.
//
// Behaviour:
//   • If deploy_status = 'decommissioned' → hard-delete immediately (all
//     K8s/Postgres/OpenSearch resources are already gone).
//   • Otherwise → set pending_delete = true and dcomm_date = NOW() so the
//     polling worker decommissions all resources first, then auto-deletes
//     the row once decommission completes.
//
// Returns:
//   204  No Content        — immediate hard-delete succeeded
//   202  Accepted          — decommission queued, row will be deleted when done
//   404  Not Found
// ---------------------------------------------------------------------------

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: org_key } = await params;
  const { searchParams } = new URL(request.url);
  const env_key = searchParams.get('env_key');

  if (!org_key) {
    return Response.json({ error: 'org_key path parameter is required' }, { status: 400 });
  }
  if (!env_key) {
    return Response.json({ error: 'env_key query parameter is required' }, { status: 400 });
  }

  try {
    const [env] = await sql<CustomerEnv[]>`
      SELECT * FROM customer_env
      WHERE org_key = ${org_key} AND env_key = ${env_key}
    `;

    if (!env) {
      return Response.json(
        { error: `Environment '${org_key}/${env_key}' not found` },
        { status: 404 },
      );
    }

    // Already fully decommissioned — safe to hard-delete right now.
    if (env.deploy_status === 'decommissioned') {
      await hardDeleteEnv(org_key, env_key);
      return new Response(null, { status: 204 });
    }

    // Still has live resources — trigger decommission and flag for auto-delete.
    const [updated] = await sql<CustomerEnv[]>`
      UPDATE customer_env
      SET
        pending_delete = true,
        dcomm_date     = NOW(),
        mod_date       = NOW()
      WHERE org_key = ${org_key}
        AND env_key = ${env_key}
      RETURNING *
    `;

    return Response.json(
      { message: 'Decommission started — environment will be deleted when complete.', env: updated },
      { status: 202 },
    );
  } catch (err) {
    console.error(`[DELETE /api/envs/${org_key}/delete?env_key=${env_key}] Error:`, err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
