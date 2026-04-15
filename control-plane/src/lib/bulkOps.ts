/**
 * bulkOps.ts — Pure utility functions for bulk environment operations.
 *
 * Extracted from EnvList.tsx so they can be unit-tested in Node environment
 * without a DOM or React renderer.
 */

// ── Key parsing ───────────────────────────────────────────────────────────────

/**
 * Parse a composite "orgKey/envKey" into its two parts.
 *
 * EnvList stores selections as a Set of "orgKey/envKey" strings so that
 * each key is globally unique across orgs.
 */
export function parseCompositeKey(key: string): { orgKey: string; envKey: string } {
  const slashIdx = key.indexOf('/');
  if (slashIdx < 0) {
    throw new Error(`Invalid composite key (no slash): "${key}"`);
  }
  return {
    orgKey: key.slice(0, slashIdx),
    envKey: key.slice(slashIdx + 1),
  };
}

// ── Result summary ────────────────────────────────────────────────────────────

export interface BulkResult {
  succeeded: number;
  failed: number;
  action: string;
}

/**
 * Compute the single summary message shown in the post-bulk-operation toast.
 *
 * Constraint: no per-item toasts — one summary message for the whole batch.
 */
export function formatBulkSummary(result: BulkResult): string {
  const { action, succeeded, failed } = result;
  if (failed === 0) {
    return `${action}: ${succeeded} succeeded`;
  }
  return `${action}: ${succeeded} succeeded, ${failed} failed`;
}

/**
 * DaisyUI alert type for the bulk result toast.
 *
 * - All succeeded  → alert-success (green)
 * - Partial failure → alert-warning (yellow)
 * - All failed      → alert-error  (red)
 */
export function bulkResultAlertType(
  result: BulkResult
): 'alert-success' | 'alert-warning' | 'alert-error' {
  const { succeeded, failed } = result;
  if (failed === 0) return 'alert-success';
  if (succeeded === 0) return 'alert-error';
  return 'alert-warning';
}

// ── Confirmation copy ─────────────────────────────────────────────────────────

/**
 * Returns the human-readable description for the bulk confirmation modal.
 */
export function bulkConfirmMessage(
  action: 'redeploy' | 'stop' | 'delete',
  count: number
): { title: string; body: string } {
  const plural = count === 1 ? '' : 's';
  if (action === 'redeploy') {
    return {
      title: `Redeploy ${count} environment${plural}?`,
      body: `Each environment will be re-provisioned with its current configuration. This will trigger a new deployment for ${count} environment${plural}.`,
    };
  }
  if (action === 'stop') {
    return {
      title: `Stop ${count} environment${plural}?`,
      body: `This will scale ${count} environment${plural} to zero replicas. All data is preserved and environments can be restarted later.`,
    };
  }
  return {
    title: `Decommission ${count} environment${plural}?`,
    body: `This will permanently delete Kubernetes namespace${plural}, database${plural}, S3 bucket${plural}, and all associated resources for ${count} environment${plural}. This action cannot be undone.`,
  };
}
