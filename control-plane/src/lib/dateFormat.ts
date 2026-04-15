/**
 * Shared date formatting utilities used on the environment detail page.
 *
 * Extracted to a separate module so they can be unit-tested without rendering
 * any React components (the test environment is pure Node, no DOM).
 */

/**
 * Format an ISO timestamp as a locale-aware human-readable date string.
 * Returns '—' for null / undefined / empty values.
 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Return a relative-time string for an ISO timestamp (e.g. "3h ago",
 * "2d ago"). Falls back to `formatDate` for timestamps older than 30 days.
 * Returns '—' for null / undefined / empty values.
 *
 * Positive diffMs  ⟹ the timestamp is in the past.
 * Negative diffMs  ⟹ the timestamp is in the future (e.g. scheduled decommission).
 */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diffMs = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diffMs);
  if (abs < 60_000) return 'just now';
  if (abs < 3_600_000) return `${Math.floor(abs / 60_000)}m ago`;
  if (abs < 86_400_000) return `${Math.floor(abs / 3_600_000)}h ago`;
  if (abs < 30 * 86_400_000) return `${Math.floor(abs / 86_400_000)}d ago`;
  return formatDate(iso);
}
