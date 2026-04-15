import { exec } from 'child_process';
import { promisify } from 'util';
import { sql } from '@/db';
import type { CustomerEnv } from '@/db/types';
import { scaffoldTenantOverlay } from '@/worker/kustomize';
import { requireApiAuth } from '@/lib/api-auth';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// GET /api/envs/[id]/manifest?env_key=xxx
//
// Generates the fully-resolved kustomize YAML manifest for the environment
// on-the-fly from the current DB state — works at any time, not just after
// provisioning.
//
// Steps:
//   1. Fetch customer_env from DB
//   2. Scaffold the tenant overlay (writes kustomize/tenants/{instance}/)
//   3. Run `kubectl kustomize` and return the rendered YAML
//
// Auth: Bearer <API_TOKEN> or valid NextAuth session
// ---------------------------------------------------------------------------
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authError = await requireApiAuth(request);
  if (authError) return authError;

  const { id: org_key } = await params;
  const { searchParams } = new URL(request.url);
  const env_key = searchParams.get('env_key');

  if (!org_key || !env_key) {
    return Response.json(
      { error: 'org_key (path) and env_key (query param) are required' },
      { status: 400 }
    );
  }

  // 1 — Fetch current env config from DB
  const [env] = await sql<CustomerEnv[]>`
    SELECT * FROM customer_env
    WHERE org_key = ${org_key} AND env_key = ${env_key}
  `;

  if (!env) {
    return Response.json(
      { error: `Environment '${org_key}/${env_key}' not found` },
      { status: 404 }
    );
  }

  try {
    // 2 — Generate fresh overlay from current DB state
    const overlayDir = await scaffoldTenantOverlay(env);

    // 3 — Render the manifest
    const { stdout, stderr } = await execAsync(`kubectl kustomize "${overlayDir}"`);
    if (stderr) {
      console.warn(`[manifest] kubectl kustomize stderr: ${stderr}`);
    }

    return new Response(stdout, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.includes('kubectl') && msg.includes('not found')) {
      return Response.json(
        { error: 'kubectl is not available in this environment' },
        { status: 503 }
      );
    }

    console.error(`[manifest] failed for ${org_key}/${env_key}:`, err);
    return Response.json({ error: 'Failed to generate manifest', detail: msg }, { status: 500 });
  }
}
