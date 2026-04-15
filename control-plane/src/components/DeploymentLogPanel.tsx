'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeploymentLog, LogAction } from '@/db/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Response shape from GET /api/envs/[id]/logs */
interface LogsApiResponse {
  org_key: string;
  env_key: string;
  logs: DeploymentLog[];
  /** Total matching rows across all pages (ignoring cursor) */
  total: number;
  /** True when there are older entries beyond the current page */
  has_more: boolean;
}

interface DeploymentLogPanelProps {
  /** Organization key — used as the path param for the logs endpoint */
  org_key: string;
  /** Environment key — passed as query param */
  env_key: string;
  /** Maximum number of log entries per page (default 50, max 500) */
  limit?: number;
  /** Poll interval in ms (default 5000) */
  pollInterval?: number;
  /** Optional CSS class applied to the outer container */
  className?: string;
}

/** Tracks the state of the in-flight retrigger request */
type RetriggerState = 'idle' | 'loading' | 'success' | 'error';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTION_LABELS: Record<string, string> = {
  provision: 'Provision',
  patch: 'Patch',
  stop: 'Stop',
  decommission: 'Decommission',
};

/**
 * DaisyUI corporate-theme status configuration.
 * Uses semantic color tokens (success/error/warning) so the theme controls
 * the exact hue — no raw Tailwind color classes.
 */
const STATUS_STYLES: Record<
  string,
  { badge: string; dot: string; label: string }
> = {
  success: {
    badge: 'badge-success',
    dot: 'bg-success',
    label: 'text-success',
  },
  failed: {
    badge: 'badge-error',
    dot: 'bg-error',
    label: 'text-error',
  },
  retrying: {
    badge: 'badge-warning',
    dot: 'bg-warning animate-pulse',
    label: 'text-warning',
  },
};

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

function relativeTime(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 0) return 'just now';
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  } catch {
    return '';
  }
}

/**
 * Build the URL for the retrigger endpoint.
 * Exported so tests can validate the URL construction logic without rendering.
 */
export function buildRetriggerUrl(org_key: string, env_key: string): string {
  return `/api/envs/${encodeURIComponent(org_key)}/retrigger?env_key=${encodeURIComponent(env_key)}`;
}

/**
 * Derive the action for the Retry button from the first (newest) log entry.
 * Returns null when there are no logs (button should be hidden).
 * Exported for testability.
 */
export function deriveRetriggerAction(logs: DeploymentLog[]): LogAction | null {
  if (logs.length === 0) return null;
  return logs[0].action;
}

// ---------------------------------------------------------------------------
// LogEntry row
// ---------------------------------------------------------------------------

function LogEntry({ entry }: { entry: DeploymentLog }) {
  const style = STATUS_STYLES[entry.status] ?? STATUS_STYLES.failed;
  const actionLabel = ACTION_LABELS[entry.action] ?? entry.action;
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="rounded-box border border-base-200 bg-base-100 px-3 py-2 text-sm"
      role="listitem"
    >
      <div className="flex items-start gap-2">
        {/* Status indicator dot */}
        <span
          className={['mt-1.5 h-2 w-2 flex-shrink-0 rounded-full', style.dot].join(' ')}
          aria-hidden="true"
        />

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {/* Action label */}
            <span className="font-semibold text-base-content">
              {actionLabel}
            </span>

            {/* Status badge — DaisyUI semantic color */}
            <span className={['badge badge-sm capitalize', style.badge].join(' ')}>
              {entry.status}
            </span>

            {/* Retry count badge */}
            {entry.retry_count > 0 && (
              <span className="badge badge-sm badge-neutral">
                attempt&nbsp;{entry.retry_count}
              </span>
            )}

            {/* Timestamp — absolute (title shows ISO for copy/paste) */}
            <time
              className="ml-auto flex-shrink-0 text-xs text-base-content/50"
              dateTime={entry.created_date}
              title={entry.created_date}
            >
              {formatTimestamp(entry.created_date)}
              <span className="ml-1 text-base-content/30">
                ({relativeTime(entry.created_date)})
              </span>
            </time>
          </div>

          {/* Error detail — collapsible */}
          {entry.error_detail && (
            <div className="mt-1">
              <button
                type="button"
                onClick={() => setExpanded((e) => !e)}
                className="text-xs text-error hover:underline focus:outline-none"
                aria-expanded={expanded}
              >
                {expanded ? '▾ hide error' : '▸ show error'}
              </button>
              {expanded && (
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded-box bg-error/10 px-2 py-1 text-xs text-error">
                  {entry.error_detail}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RetryButton
// ---------------------------------------------------------------------------

interface RetryButtonProps {
  action: LogAction;
  state: RetriggerState;
  onRetry: () => void;
}

function RetryButton({ action, state, onRetry }: RetryButtonProps) {
  const actionLabel = ACTION_LABELS[action] ?? action;
  const isLoading = state === 'loading';

  return (
    <button
      type="button"
      onClick={onRetry}
      disabled={isLoading}
      aria-label={`Retry ${actionLabel}`}
      aria-busy={isLoading}
      className="btn btn-xs btn-warning"
    >
      {isLoading && (
        <span className="loading loading-spinner loading-xs" aria-hidden="true" />
      )}
      {isLoading ? 'Retrying…' : `↺ Retry ${actionLabel}`}
    </button>
  );
}

// ---------------------------------------------------------------------------
// DeploymentLogPanel
// ---------------------------------------------------------------------------

/**
 * DeploymentLogPanel
 *
 * Displays deployment log entries for a single environment, auto-refreshed
 * on a 5-second poll interval.  Uses the existing
 * GET /api/envs/[id]/status?env_key=... endpoint which returns both status
 * metadata and the log array in one round-trip.
 *
 * Features:
 * - Auto-refresh every `pollInterval` ms (default 5 s)
 * - Shows operation (provision/patch/stop/decommission), status
 *   (success/failed/retrying), timestamp, and collapsible error detail
 * - "Last updated" footer so operators know data freshness
 * - Unmounts cleanly — clears interval on component removal
 * - Retry button: reads the newest log entry's action and calls
 *   POST /api/envs/[id]/retrigger with that action; shows loading /
 *   error / success feedback inline in the panel header
 */
/**
 * Build the URL for the historical logs endpoint.
 * Exported for testability.
 */
export function buildLogsUrl(
  org_key: string,
  env_key: string,
  limit: number,
  before_id?: number
): string {
  const base = `/api/envs/${encodeURIComponent(org_key)}/logs?env_key=${encodeURIComponent(env_key)}&limit=${limit}`;
  return before_id !== undefined ? `${base}&before_id=${before_id}` : base;
}

/**
 * Determine whether a scroll container is "near the bottom".
 * Returns true when the distance from the bottom edge is less than `threshold`
 * pixels (default 60px).  This is the auto-scroll re-enable threshold.
 *
 * Extracted as a pure function so it can be tested without a DOM environment.
 * The `handleScroll` callback delegates to this function.
 *
 * @param scrollHeight - element.scrollHeight
 * @param scrollTop    - element.scrollTop
 * @param clientHeight - element.clientHeight
 * @param threshold    - pixel distance from bottom that counts as "near" (default 60)
 */
export function computeIsNearBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = 60
): boolean {
  return scrollHeight - scrollTop - clientHeight < threshold;
}

export function DeploymentLogPanel({
  org_key,
  env_key,
  limit = 50,
  pollInterval = 5_000,
  className = '',
}: DeploymentLogPanelProps) {
  const [logs, setLogs] = useState<DeploymentLog[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Retrigger state
  const [retriggerState, setRetriggerState] = useState<RetriggerState>('idle');
  const [retriggerError, setRetriggerError] = useState<string | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Ref attached to the scrollable log container div */
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  /** Sentinel div at the bottom of the log list — scrolled into view on new entries */
  const bottomRef = useRef<HTMLDivElement>(null);
  /**
   * Tracks whether the user has manually scrolled up.
   * When true we suppress auto-scroll so we don't yank the user's position.
   * Resets to true (auto-scroll re-enabled) when the user scrolls back to the
   * bottom or when new props (org_key/env_key) change.
   */
  const autoScrollRef = useRef(true);

  /**
   * Fetch the first page of historical log entries from the dedicated
   * GET /api/envs/[id]/logs endpoint, replacing any existing log state.
   * Called on mount and on every poll tick.
   */
  const fetchLogs = useCallback(async () => {
    try {
      const url = buildLogsUrl(org_key, env_key, limit);
      const res = await fetch(url);

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `HTTP ${res.status}`
        );
      }

      const data = (await res.json()) as LogsApiResponse;
      setLogs(data.logs ?? []);
      setTotal(data.total ?? 0);
      setHasMore(data.has_more ?? false);
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load logs');
    } finally {
      setLoading(false);
    }
  }, [org_key, env_key, limit]);

  /**
   * Load older log entries using cursor-based pagination.
   * Appends results to the existing `logs` array rather than replacing it,
   * so the user sees a continuous scrollable history.
   */
  const fetchMoreLogs = useCallback(async () => {
    if (!hasMore || loadingMore || logs.length === 0) return;
    const oldestId = logs[logs.length - 1].deployment_log_id;
    setLoadingMore(true);
    try {
      const url = buildLogsUrl(org_key, env_key, limit, oldestId);
      const res = await fetch(url);

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `HTTP ${res.status}`
        );
      }

      const data = (await res.json()) as LogsApiResponse;
      setLogs((prev) => [...prev, ...(data.logs ?? [])]);
      setTotal(data.total ?? 0);
      setHasMore(data.has_more ?? false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more logs');
    } finally {
      setLoadingMore(false);
    }
  }, [org_key, env_key, limit, hasMore, loadingMore, logs]);

  // Initial fetch + polling (first page only — poll refreshes latest entries)
  useEffect(() => {
    fetchLogs();

    intervalRef.current = setInterval(fetchLogs, pollInterval);
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchLogs, pollInterval]);

  // Reset auto-scroll when the environment changes
  useEffect(() => {
    autoScrollRef.current = true;
  }, [org_key, env_key]);

  /**
   * Auto-scroll to bottom when new log entries arrive.
   * Skipped if the user has manually scrolled up — we detect this via the
   * onScroll handler below and flip autoScrollRef.current to false.
   */
  useEffect(() => {
    if (autoScrollRef.current && scrollContainerRef.current) {
      // Logs are sorted newest-first — pin to top so new entries are visible.
      // Uses scrollTop not scrollIntoView to avoid hijacking the page viewport.
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [logs]);

  /**
   * Track whether the user has scrolled away from the bottom.
   * "Near bottom" = within 60px.  Re-enables auto-scroll when they scroll
   * back down so the next poll result pulls them to the latest entry again.
   */
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    // Re-enable auto-scroll when the user scrolls back to the top (newest entries).
    autoScrollRef.current = el.scrollTop < 60;
  }, []);

  /** Programmatically jump to the latest entry (top) and re-enable auto-scroll. */
  const scrollToBottom = useCallback(() => {
    autoScrollRef.current = true;
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, []);

  // -------------------------------------------------------------------------
  // Retrigger handler
  // -------------------------------------------------------------------------

  const handleRetrigger = useCallback(async () => {
    const action = deriveRetriggerAction(logs);
    if (!action) return;

    setRetriggerState('loading');
    setRetriggerError(null);

    try {
      const url = buildRetriggerUrl(org_key, env_key);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `HTTP ${res.status}`
        );
      }

      setRetriggerState('success');
      // Refresh logs immediately so the new synthetic 'success' entry appears.
      await fetchLogs();
      // Auto-reset back to idle after 4 s so the success banner disappears.
      setTimeout(() => setRetriggerState('idle'), 4_000);
    } catch (err) {
      setRetriggerState('error');
      setRetriggerError(
        err instanceof Error ? err.message : 'Retrigger request failed'
      );
    }
  }, [logs, org_key, env_key, fetchLogs]);

  // Derived: action for the retry button (from newest log entry)
  const retriggerAction = deriveRetriggerAction(logs);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <section
      className={['card border border-base-300 bg-base-100 shadow-sm', className]
        .filter(Boolean)
        .join(' ')}
      aria-label={`Deployment logs for ${org_key}/${env_key}`}
    >
      {/* Header */}
      <div className="card-body p-0">
        <div className="flex items-center justify-between border-b border-base-200 px-4 py-3">
          <h3 className="card-title text-sm">
            Deployment Logs
            <span className="ml-1 font-mono text-xs font-normal text-base-content/50">
              {org_key}/{env_key}
            </span>
          </h3>

          <div className="flex items-center gap-2">
            {/* Retry button — visible when logs exist */}
            {retriggerAction && (
              <RetryButton
                action={retriggerAction}
                state={retriggerState}
                onRetry={handleRetrigger}
              />
            )}

            {/* Live indicator */}
            <span
              className="inline-flex items-center gap-1 text-xs text-base-content/40"
              title="Auto-refreshes every 5 seconds"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" aria-hidden="true" />
              live
            </span>

            {/* Manual refresh button */}
            <button
              type="button"
              onClick={fetchLogs}
              disabled={loading}
              className="btn btn-xs btn-ghost btn-circle"
              aria-label="Refresh logs"
              title="Refresh now"
            >
              <svg
                className={['h-3.5 w-3.5', loading ? 'animate-spin' : ''].filter(Boolean).join(' ')}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
          </div>
        </div>

        {/* Retrigger feedback banners */}
        {retriggerState === 'success' && (
          <div
            role="status"
            aria-live="polite"
            className="alert alert-success rounded-none border-x-0 border-t-0 py-2 text-sm"
          >
            ✓ Retrigger queued — worker will pick it up on the next poll cycle.
          </div>
        )}
        {retriggerState === 'error' && retriggerError && (
          <div
            role="alert"
            aria-live="assertive"
            className="alert alert-error rounded-none border-x-0 border-t-0 py-2 text-sm"
          >
            <span className="font-medium">Retrigger failed:</span>
            {retriggerError}
          </div>
        )}

        {/* Body */}
        <div className="p-4">
          {/* Error banner */}
          {error && (
            <div role="alert" className="alert alert-error mb-3 text-sm">
              <span className="font-medium">Error:</span>
              {error}
            </div>
          )}

          {/* Loading skeleton — first paint only */}
          {loading && logs.length === 0 && (
            <div className="space-y-2" aria-busy="true" aria-label="Loading logs">
              {[...Array(3)].map((_, i) => (
                <div
                  key={i}
                  className="h-10 animate-pulse rounded-box bg-base-200"
                />
              ))}
            </div>
          )}

          {/* Empty state */}
          {!loading && logs.length === 0 && !error && (
            <p className="py-6 text-center text-sm text-base-content/40">
              No deployment log entries yet.
            </p>
          )}
        </div>{/* /p-4 body */}

        {/* Log entries — scrollable history container */}
        {logs.length > 0 && (
          <>
            {/* Entry count summary */}
            <p className="mb-2 text-xs text-base-content/50">
              Showing {logs.length} of {total} entr{total === 1 ? 'y' : 'ies'}
            </p>

            {/* Scrollable log container — auto-scrolls to bottom on new entries */}
            <div
              ref={scrollContainerRef}
              onScroll={handleScroll}
              className="relative max-h-96 overflow-y-auto rounded-box border border-base-200 bg-base-50 p-2"
              aria-label="Log history"
              aria-live="polite"
              aria-relevant="additions"
            >
              {/* Load older entries button — shown at the top when more pages exist */}
              {hasMore && (
                <div className="mb-2 flex justify-center">
                  <button
                    type="button"
                    onClick={fetchMoreLogs}
                    disabled={loadingMore}
                    className="btn btn-ghost btn-xs"
                    aria-label="Load older log entries"
                  >
                    {loadingMore ? (
                      <>
                        <span className="loading loading-spinner loading-xs" aria-hidden="true" />
                        Loading…
                      </>
                    ) : (
                      '↑ Load older entries'
                    )}
                  </button>
                </div>
              )}

              {/* Log entry list — newest first (index 0), oldest last */}
              <div className="space-y-2" role="list" aria-label="Log entries">
                {logs.map((entry) => (
                  <LogEntry key={entry.deployment_log_id} entry={entry} />
                ))}
              </div>

              {/* Bottom sentinel — scrollIntoView target for auto-scroll */}
              <div ref={bottomRef} aria-hidden="true" />
            </div>

            {/* Jump-to-latest FAB — appears when user has scrolled up */}
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={scrollToBottom}
                className="btn btn-xs btn-ghost text-base-content/60"
                aria-label="Scroll to latest log entry"
              >
                ↓ Latest
              </button>
            </div>
          </>
        )}

        {/* Footer — last updated timestamp */}
        {lastUpdated && (
          <div className="border-t border-base-200 px-4 py-2 text-right text-xs text-base-content/40">
            Last updated: {lastUpdated.toLocaleTimeString()}
          </div>
        )}
      </div>{/* /card-body */}
    </section>
  );
}
