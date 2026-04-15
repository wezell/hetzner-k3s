/**
 * Next.js instrumentation hook — called once when the server starts.
 *
 * Starts the polling worker that detects pending customer_env records and
 * executes the provisioning / teardown workflows.
 *
 * This file runs in the Node.js runtime only (not edge). The worker uses
 * @kubernetes/client-node (Node.js-only) and postgres.js, both of which
 * require Node.js APIs.
 *
 * See: https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */

export async function register() {
  // Only run in the Node.js runtime — not in the edge runtime or during
  // Next.js build-time static generation.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Skip worker startup during next build (no DB / K8s available).
  if (process.env.WORKER_DISABLED === 'true') {
    console.log('[instrumentation] Worker disabled via WORKER_DISABLED=true');
    return;
  }

  // Lazy-import keeps the worker module out of the edge bundle.
  const { startWorker } = await import('./worker/poll');
  startWorker();
}
