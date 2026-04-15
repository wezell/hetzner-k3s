'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { CustomerEnv, DeploymentLog } from '@/db/types';
import { StatusBadge } from '@/components/StatusBadge';
import { DeploymentLogPanel } from '@/components/DeploymentLogPanel';
import ConfirmDeleteModal from '@/components/ConfirmDeleteModal';
import { useToast } from '@/hooks/useToast';
import Toast from '@/components/Toast';
import {
  parseCompositeKey,
  formatBulkSummary,
  bulkResultAlertType,
  bulkConfirmMessage,
  type BulkResult,
} from '@/lib/bulkOps';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StatusResponse {
  org_key: string;
  env_key: string;
  deploy_status: CustomerEnv['deploy_status'];
  last_deploy_date: string | null;
  stop_date: string | null;
  dcomm_date: string | null;
  mod_date: string;
  /**
   * Number of retry attempts for the current (or most-recent) operation since
   * the last successful deployment_log entry.  0 = no retries outstanding.
   */
  current_retry_count: number;
  logs: DeploymentLog[];
}

interface EnvRow extends CustomerEnv {
  /** Live status polled from the API, null while loading */
  live?: StatusResponse | null;
  /** True while the status fetch is in-flight */
  polling?: boolean;
  /** True while a stop action is being submitted */
  stopping?: boolean;
  /** Error from the last stop attempt */
  stopError?: string | null;
  /** True while a decommission action is being submitted */
  decommissioning?: boolean;
  /** Error from the last decommission attempt */
  decommissionError?: string | null;
}

interface EnvListProps {
  /** Bump to trigger a re-fetch of the env list */
  refreshKey?: number;
  /** Poll interval in ms (default 5000) */
  pollInterval?: number;
  /** When set, pre-populate the org search field (and filter by that org) */
  orgKey?: string;
  /** Pre-populate the search box (e.g. from URL ?q= param) */
  initialQuery?: string;
  /**
   * Called whenever the set of selected env keys changes.
   * Each key is formatted as "orgKey/envKey".
   */
  onSelectionChange?: (selectedKeys: string[]) => void;
}

// Imported from @/lib/envSearch and re-exported for testability
import { buildEnvUrl } from '@/lib/envSearch';
export { buildEnvUrl };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum retry attempts before the worker marks an env 'failed'. */
const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string | null | undefined): string {
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
 * Returns a compact relative-time string (e.g. "just now", "4m ago", "2h ago",
 * "3d ago") for timestamps within the last 30 days.  Falls back to the
 * absolute formatted date for older values so operators still see a real date.
 *
 * Use `formatDate(iso)` as the `title` attribute to surface the absolute
 * timestamp on hover.
 */
function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diffMs = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diffMs);
  if (abs < 60_000)               return 'just now';
  if (abs < 3_600_000)            return `${Math.floor(abs / 60_000)}m ago`;
  if (abs < 86_400_000)           return `${Math.floor(abs / 3_600_000)}h ago`;
  if (abs < 30 * 86_400_000)      return `${Math.floor(abs / 86_400_000)}d ago`;
  // Older than 30 days — fall back to absolute date
  return formatDate(iso);
}

/** Returns a short human-readable action label */
function actionLabel(action: DeploymentLog['action']): string {
  switch (action) {
    case 'provision':     return 'Provision';
    case 'patch':         return 'Patch';
    case 'stop':          return 'Stop';
    case 'decommission':  return 'Decommission';
    default:              return action;
  }
}

/** Which statuses allow the Stop action */
function isStoppable(status: CustomerEnv['deploy_status']): boolean {
  return status === 'deployed';
}

/** Which statuses allow the Decommission action */
function isDecommissionable(status: CustomerEnv['deploy_status']): boolean {
  return status === 'stopped' || status === 'failed';
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Spinner({ small = false }: { small?: boolean }) {
  return (
    <span
      className={`loading loading-spinner${small ? ' loading-xs' : ' loading-sm'}`}
      aria-hidden="true"
    />
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={className || undefined}>
      {children}
    </th>
  );
}

function Td({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={['align-top', className].filter(Boolean).join(' ')}>
      {children}
    </td>
  );
}

/**
 * Log entry row with coloured status pill.
 */
function LogEntry({ log }: { log: DeploymentLog }) {
  const statusVariant: Record<DeploymentLog['status'], string> = {
    success: 'badge-success',
    failed: 'badge-error',
    retrying: 'badge-warning',
  };
  const variant = statusVariant[log.status] ?? 'badge-ghost';

  return (
    <div className="flex flex-wrap items-start gap-2 text-xs">
      <span className={`badge badge-sm ${variant}`}>
        {log.status}
      </span>
      <span className="font-medium text-base-content/70">
        {actionLabel(log.action)}
      </span>
      {log.error_detail && (
        <span className="truncate font-mono text-error">
          {log.error_detail}
        </span>
      )}
      {log.retry_count > 0 && (
        <span className="shrink-0 text-base-content/50">
          (retry {log.retry_count})
        </span>
      )}
      <span className="ml-auto shrink-0 text-base-content/50">
        {formatDate(log.created_date)}
      </span>
    </div>
  );
}

/**
 * Derive the status to display, accounting for elapsed lifecycle dates.
 * If dcomm_date or stop_date has elapsed but the worker hasn't updated the
 * deploy_status yet, show the expected transitional status instead.
 */
function effectiveStatus(
  status: CustomerEnv['deploy_status'],
  stopIso: string | null | undefined,
  dcommIso: string | null | undefined,
): CustomerEnv['deploy_status'] {
  const now = Date.now();
  if (dcommIso && new Date(dcommIso).getTime() <= now && status !== 'decommissioned') {
    return 'decommissioning';
  }
  if (
    stopIso &&
    new Date(stopIso).getTime() <= now &&
    !['stopped', 'stopping', 'decommissioning', 'decommissioned'].includes(status)
  ) {
    return 'stopping';
  }
  return status;
}

/**
 * Status cell — shows the effective deploy_status badge with scheduled date context.
 * Displays a tiny spinner while the poll is in-flight.
 */
function StatusCell({ row }: { row: EnvRow }) {
  if (row.polling && !row.live) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-base-content/60">
        <Spinner small />
        Fetching status…
      </div>
    );
  }

  const rawStatus = row.live?.deploy_status ?? row.deploy_status;
  const stopIso   = row.live?.stop_date  ?? row.stop_date;
  const dcommIso  = row.live?.dcomm_date ?? row.dcomm_date;
  const status    = effectiveStatus(rawStatus, stopIso, dcommIso);

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <StatusBadge status={status} />
        {row.polling && <Spinner small />}
      </div>
      {stopIso && (
        <div className="flex items-center gap-1 text-xs text-base-content/60">
          <span className="badge badge-xs badge-warning">Stop</span>
          <span title={formatDate(stopIso)}>{formatRelativeTime(stopIso)}</span>
        </div>
      )}
      {dcommIso && (
        <div className="flex items-center gap-1 text-xs text-base-content/60">
          <span className="badge badge-xs badge-error">Dcomm</span>
          <span title={formatDate(dcommIso)}>{formatRelativeTime(dcommIso)}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Retry indicator cell.
 *
 * Shows nothing (—) when there are no active retries.
 * Turns amber when the env has used `MAX_RETRIES - 1` attempts (approaching
 * the cap) and red when it has hit `MAX_RETRIES` attempts (at the cap, next
 * failure will mark the env 'failed' and require manual intervention).
 */
function RetryCell({ row }: { row: EnvRow }) {
  const retryCount = row.live?.current_retry_count ?? 0;

  if (retryCount === 0) {
    return <span className="text-xs text-base-content/40">—</span>;
  }

  const atCap       = retryCount >= MAX_RETRIES;
  const approaching = retryCount === MAX_RETRIES - 1;

  const badgeVariant = atCap ? 'badge-error' : approaching ? 'badge-warning' : 'badge-ghost';

  const containerClasses = [
    'badge badge-sm gap-1.5 tabular-nums font-semibold',
    badgeVariant,
  ].join(' ');

  const dotClasses = [
    'h-1.5 w-1.5 rounded-full flex-shrink-0',
    atCap
      ? 'bg-current animate-pulse'
      : approaching
        ? 'bg-current animate-pulse'
        : 'bg-current opacity-50',
  ].join(' ');

  const label = `${retryCount}\u202f/\u202f${MAX_RETRIES}`;
  const title = atCap
    ? `At retry cap (${retryCount}/${MAX_RETRIES}) — next failure marks env 'failed'`
    : `${retryCount} of ${MAX_RETRIES} retry attempts used`;

  return (
    <span className={containerClasses} title={title} aria-label={title}>
      <span className={dotClasses} aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * Actions cell — Stop button for deployed environments, Decommission button
 * for stopped/failed environments, and a Logs toggle button.
 */
function ActionsCell({
  row,
  onStop,
  onDecommission,
  onDelete,
  onToggleLogs,
  logsExpanded,
}: {
  row: EnvRow;
  onStop: (orgKey: string, envKey: string) => void;
  onDecommission: (orgKey: string, envKey: string) => void;
  onDelete: (row: EnvRow) => void;
  onToggleLogs: (orgKey: string, envKey: string) => void;
  logsExpanded: boolean;
}) {
  const liveStatus = row.live?.deploy_status ?? row.deploy_status;
  const canStop = isStoppable(liveStatus);
  const canDecommission = isDecommissionable(liveStatus);

  return (
    <div className="space-y-1.5">
      {/* Logs toggle button — always visible */}
      <button
        type="button"
        onClick={() => onToggleLogs(row.org_key, row.env_key)}
        className={`btn btn-xs${logsExpanded ? ' btn-primary' : ' btn-ghost'}`}
        title={logsExpanded ? 'Collapse deployment logs' : 'Expand deployment logs'}
        aria-expanded={logsExpanded}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className={['h-3 w-3 transition-transform', logsExpanded ? 'rotate-90' : ''].join(' ')}
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
            clipRule="evenodd"
          />
        </svg>
        Logs
      </button>
      {/* Stop button */}
      {(canStop || row.stopping) && (
        <div className="space-y-1">
          <button
            type="button"
            disabled={row.stopping}
            onClick={() => onStop(row.org_key, row.env_key)}
            className={`btn btn-xs${row.stopping ? ' btn-disabled' : ' btn-warning'}`}
            title="Scale this environment to 0 replicas"
          >
            {row.stopping ? (
              <>
                <Spinner small />
                Stopping…
              </>
            ) : (
              <>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-3 w-3"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <rect x="4" y="4" width="12" height="12" rx="2" />
                </svg>
                Stop
              </>
            )}
          </button>
          {row.stopError && (
            <p className="text-xs text-error">{row.stopError}</p>
          )}
        </div>
      )}

      {/* Decommission button */}
      {(canDecommission || row.decommissioning) && (
        <div className="space-y-1">
          <button
            type="button"
            disabled={row.decommissioning}
            onClick={() => onDecommission(row.org_key, row.env_key)}
            className={`btn btn-xs${row.decommissioning ? ' btn-disabled' : ' btn-error'}`}
            title="Permanently tear down this environment (irreversible)"
          >
            {row.decommissioning ? (
              <>
                <Spinner small />
                Scheduling…
              </>
            ) : (
              <>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-3 w-3"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z"
                    clipRule="evenodd"
                  />
                </svg>
                Decommission
              </>
            )}
          </button>
          {row.decommissionError && (
            <p className="text-xs text-error">{row.decommissionError}</p>
          )}
        </div>
      )}

      {/* Delete button — always visible */}
      <button
        type="button"
        className="btn btn-xs btn-ghost text-error"
        onClick={() => onDelete(row)}
        title="Delete this environment (triggers decommission if not already done)"
      >
        Delete
      </button>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function EnvList({
  refreshKey = 0,
  pollInterval = 5_000,
  orgKey,
  initialQuery,
  onSelectionChange,
}: EnvListProps) {
  const [envs, setEnvs] = useState<EnvRow[]>([]);
  const [listState, setListState] = useState<
    'idle' | 'loading' | 'error' | 'ready'
  >('idle');
  const [listError, setListError] = useState<string | null>(null);
  /** Set of "orgKey/envKey" strings whose log panel is currently expanded */
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  /** Set of "orgKey/envKey" strings that are currently selected via checkboxes */
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  /** True while a bulk operation is in-flight */
  const [bulkLoading, setBulkLoading] = useState(false);
  /** Result of last bulk operation — drives the summary toast */
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  /** Pending confirmation: which action + how many envs. Non-null = modal open. */
  const [bulkConfirmPending, setBulkConfirmPending] = useState<{
    action: 'redeploy' | 'stop' | 'delete';
    keys: string[];
  } | null>(null);
  /** Env pending single-row delete confirmation. Non-null = modal open. */
  const [deleteEnv, setDeleteEnv] = useState<EnvRow | null>(null);
  const { toast, showToast, clearToast } = useToast();

  // ── Search state ──────────────────────────────────────────────────────────
  /** Org key search — exact match, pre-populated from orgKey prop */
  const [query, setQuery] = useState(initialQuery ?? '');
  /** Environment name search — wildcard, e.g. prod* or *staging* */


  const abortListRef = useRef<AbortController | null>(null);
  // Map of "orgKey/envKey" → AbortController for per-row status fetches
  const abortStatusRef = useRef<Map<string, AbortController>>(new Map());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const envsRef = useRef<EnvRow[]>([]);
  envsRef.current = envs;
  // Keep onSelectionChange in a ref so it is never a useCallback dependency
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  // Stable refs so bulk callbacks can read the latest search state without being
  // listed as dependencies (prevents them from being recreated on every keystroke)
  const queryRef = useRef(query);
  queryRef.current = query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loadEnvsRef = useRef<(q: string) => Promise<void>>(null as any);

  // ── Fetch status for a single env row ─────────────────────────────────────

  const fetchStatus = useCallback(
    async (orgKey: string, envKey: string) => {
      const mapKey = `${orgKey}/${envKey}`;

      // Cancel any in-flight request for this row
      abortStatusRef.current.get(mapKey)?.abort();
      const controller = new AbortController();
      abortStatusRef.current.set(mapKey, controller);

      // Mark row as polling
      setEnvs((prev) =>
        prev.map((r) =>
          r.org_key === orgKey && r.env_key === envKey
            ? { ...r, polling: true }
            : r
        )
      );

      try {
        const res = await fetch(
          `/api/envs/${encodeURIComponent(orgKey)}/status?env_key=${encodeURIComponent(envKey)}&limit=1`,
          { signal: controller.signal }
        );

        if (!res.ok) {
          // Non-2xx — mark not-polling but keep previous live data
          setEnvs((prev) =>
            prev.map((r) =>
              r.org_key === orgKey && r.env_key === envKey
                ? { ...r, polling: false }
                : r
            )
          );
          return;
        }

        const data: StatusResponse = await res.json();
        setEnvs((prev) =>
          prev.map((r) =>
            r.org_key === orgKey && r.env_key === envKey
              ? { ...r, live: data, polling: false }
              : r
          )
        );
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        // Network error — silently clear polling flag
        setEnvs((prev) =>
          prev.map((r) =>
            r.org_key === orgKey && r.env_key === envKey
              ? { ...r, polling: false }
              : r
          )
        );
      }
    },
    []
  );

  // ── Stop an environment (set stop_date = NOW()) ───────────────────────────

  const stopEnv = useCallback(
    async (orgKey: string, envKey: string) => {
      // Optimistically enter stopping state in UI
      setEnvs((prev) =>
        prev.map((r) =>
          r.org_key === orgKey && r.env_key === envKey
            ? { ...r, stopping: true, stopError: null }
            : r
        )
      );

      try {
        const res = await fetch(
          `/api/envs/${encodeURIComponent(orgKey)}/stop?env_key=${encodeURIComponent(envKey)}`,
          { method: 'PATCH' }
        );

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const message =
            (body as { detail?: string; error?: string }).detail ??
            (body as { error?: string }).error ??
            `Server error ${res.status}`;
          setEnvs((prev) =>
            prev.map((r) =>
              r.org_key === orgKey && r.env_key === envKey
                ? { ...r, stopping: false, stopError: message }
                : r
            )
          );
          return;
        }

        // Optimistically set replicas=0 and stop_date so the UI reflects the
        // change immediately. effectiveStatus() will show 'stopping' until the
        // worker patches K8s and transitions to 'stopped'.
        const stopNow = new Date().toISOString();
        setEnvs((prev) =>
          prev.map((r) =>
            r.org_key === orgKey && r.env_key === envKey
              ? {
                  ...r,
                  stopping: false,
                  replicas: 0,
                  stop_date: stopNow,
                  live: r.live
                    ? { ...r.live, replicas: 0, stop_date: stopNow }
                    : null,
                }
              : r
          )
        );
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Network error';
        setEnvs((prev) =>
          prev.map((r) =>
            r.org_key === orgKey && r.env_key === envKey
              ? { ...r, stopping: false, stopError: message }
              : r
          )
        );
      }
    },
    [fetchStatus]
  );

  // ── Decommission an environment (set dcomm_date = NOW()) ─────────────────

  const decommissionEnvCallback = useCallback(
    async (orgKey: string, envKey: string) => {
      const label = `${orgKey}/${envKey}`;
      const confirmed = window.confirm(
        `Permanently decommission "${label}"?\n\nThis will delete the Kubernetes namespace, database, S3 bucket, and all associated resources. This action cannot be undone.`
      );
      if (!confirmed) return;

      // Enter decommissioning state
      setEnvs((prev) =>
        prev.map((r) =>
          r.org_key === orgKey && r.env_key === envKey
            ? { ...r, decommissioning: true, decommissionError: null }
            : r
        )
      );

      try {
        const res = await fetch(
          `/api/envs/${encodeURIComponent(orgKey)}/decommission?env_key=${encodeURIComponent(envKey)}`,
          { method: 'PATCH' }
        );

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const message =
            (body as { detail?: string; error?: string }).detail ??
            (body as { error?: string }).error ??
            `Server error ${res.status}`;
          setEnvs((prev) =>
            prev.map((r) =>
              r.org_key === orgKey && r.env_key === envKey
                ? { ...r, decommissioning: false, decommissionError: message }
                : r
            )
          );
          return;
        }

        // Optimistically show 'decommissioning' status so the badge updates immediately
        const dcommNow = new Date().toISOString();
        setEnvs((prev) =>
          prev.map((r) =>
            r.org_key === orgKey && r.env_key === envKey
              ? {
                  ...r,
                  decommissioning: false,
                  dcomm_date: dcommNow,
                  deploy_status: 'decommissioning',
                  live: r.live
                    ? { ...r.live, deploy_status: 'decommissioning', dcomm_date: dcommNow }
                    : null,
                }
              : r
          )
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Network error';
        setEnvs((prev) =>
          prev.map((r) =>
            r.org_key === orgKey && r.env_key === envKey
              ? { ...r, decommissioning: false, decommissionError: message }
              : r
          )
        );
      }
    },
    [fetchStatus]
  );

  // ── Toggle log panel for a row ────────────────────────────────────────────

  const toggleLogs = useCallback((orgKey: string, envKey: string) => {
    const key = `${orgKey}/${envKey}`;
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  // ── Selection helpers ─────────────────────────────────────────────────────

  const toggleRowSelection = useCallback((rowKey: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) {
        next.delete(rowKey);
      } else {
        next.add(rowKey);
      }
      onSelectionChangeRef.current?.([...next]);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedKeys((prev) => {
      const allKeys = envsRef.current.map((r) => `${r.org_key}/${r.env_key}`);
      const allSelected = allKeys.length > 0 && allKeys.every((k) => prev.has(k));
      const next = allSelected ? new Set<string>() : new Set(allKeys);
      onSelectionChangeRef.current?.([...next]);
      return next;
    });
  }, []);

  // ── Bulk operations ───────────────────────────────────────────────────────

  /** Open the DaisyUI confirmation modal for a bulk action */
  const handleBulkRedeploy = useCallback(() => {
    if (selectedKeys.size === 0) return;
    setBulkConfirmPending({ action: 'redeploy', keys: [...selectedKeys] });
  }, [selectedKeys]);

  const handleBulkStop = useCallback(() => {
    if (selectedKeys.size === 0) return;
    setBulkConfirmPending({ action: 'stop', keys: [...selectedKeys] });
  }, [selectedKeys]);

  const handleBulkDelete = useCallback(() => {
    if (selectedKeys.size === 0) return;
    setBulkConfirmPending({ action: 'delete', keys: [...selectedKeys] });
  }, [selectedKeys]);

  /**
   * Execute the pending bulk action after the user confirms in the modal.
   * Uses parseCompositeKey to split each composite key and fans out the
   * API calls in parallel. Reports a single summary result — no per-item toasts.
   */
  const executeBulkAction = useCallback(async () => {
    if (!bulkConfirmPending) return;
    const { action, keys } = bulkConfirmPending;

    setBulkConfirmPending(null);
    setBulkLoading(true);
    setBulkResult(null);

    let succeeded = 0;
    let failed = 0;

    await Promise.all(
      keys.map(async (key) => {
        const { orgKey, envKey } = parseCompositeKey(key);
        try {
          let res: Response;
          if (action === 'redeploy') {
            res = await fetch(
              `/api/envs/${encodeURIComponent(orgKey)}/retrigger?env_key=${encodeURIComponent(envKey)}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'provision' }),
              }
            );
          } else if (action === 'stop') {
            res = await fetch(
              `/api/envs/${encodeURIComponent(orgKey)}/stop?env_key=${encodeURIComponent(envKey)}`,
              { method: 'PATCH' }
            );
          } else {
            res = await fetch(
              `/api/envs/${encodeURIComponent(orgKey)}/decommission?env_key=${encodeURIComponent(envKey)}`,
              { method: 'PATCH' }
            );
          }
          if (res.ok) succeeded++;
          else failed++;
        } catch {
          failed++;
        }
      })
    );

    setBulkLoading(false);
    // Single summary result — constraints require no per-item toasts
    setBulkResult({
      succeeded,
      failed,
      action: action === 'redeploy' ? 'Redeploy' : action === 'stop' ? 'Stop' : 'Delete',
    });
    setSelectedKeys(new Set());
    onSelectionChangeRef.current?.([]);
    // Refresh list so statuses reflect the operations
    loadEnvsRef.current(queryRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkConfirmPending]);

  // ── Poll all visible rows ─────────────────────────────────────────────────

  const pollAll = useCallback(() => {
    for (const row of envsRef.current) {
      fetchStatus(row.org_key, row.env_key);
    }
  }, [fetchStatus]);

  // ── Load the env list ─────────────────────────────────────────────────────

  const loadEnvs = useCallback(async (q: string) => {
    abortListRef.current?.abort();
    const controller = new AbortController();
    abortListRef.current = controller;

    setListState('loading');
    setListError(null);

    try {
      // Unified search: ?q= when no org context, ?org_key=&name= within org
      const params = new URLSearchParams();
      if (orgKey?.trim()) {
        params.set('org_key', orgKey.trim());
        if (q.trim()) params.set('name', q.trim());
      } else if (q.trim()) {
        params.set('q', q.trim());
      }
      const url = params.toString() ? `/api/envs?${params}` : '/api/envs';
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setListError((body as { error?: string }).error ?? `Server error ${res.status}`);
        setListState('error');
        return;
      }
      const rows: CustomerEnv[] = await res.json();
      setEnvs(rows.map((r) => ({ ...r, live: null, polling: false })));
      // Clear selection on every list reload so stale selections don't persist
      setSelectedKeys(new Set());
      onSelectionChangeRef.current?.([]);
      setListState('ready');
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setListError('Network error. Could not load environments.');
      setListState('error');
    }
  }, []);
  loadEnvsRef.current = loadEnvs;

  // ── Effects ───────────────────────────────────────────────────────────────

  // Sync query when initialQuery prop changes (e.g. user clicks a different org)
  useEffect(() => {
    setQuery(initialQuery ?? '');
  }, [initialQuery]);

  // Debounce the search query — wait 300 ms after the last keystroke
  useEffect(() => {
    const timer = setTimeout(() => {
      loadEnvs(query);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Reload immediately whenever refreshKey changes (e.g. after create)
  useEffect(() => {
    loadEnvs(query);
    return () => abortListRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // Surface load errors as toasts
  useEffect(() => {
    if (listState === 'error' && listError) showToast(listError, 'error');
  }, [listState, listError, showToast]);

  // Start polling once list is ready; restart whenever env list changes
  useEffect(() => {
    if (listState !== 'ready') return;

    // Immediate first poll
    pollAll();

    // Recurring interval
    timerRef.current = setInterval(pollAll, pollInterval);

    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current);
      // Cancel all in-flight status fetches
      for (const ctrl of abortStatusRef.current.values()) ctrl.abort();
      abortStatusRef.current.clear();
    };
  }, [listState, pollAll, pollInterval, envs.length]);

  // ── Render ────────────────────────────────────────────────────────────────

  const hasActiveSearch = query.trim() !== '';
  const handleClearSearch = () => setQuery('');

  return (
    <div className="flex flex-col gap-4">
      {/* ── Unified search bar ────────────────────────────────────────────── */}
      <div
        role="search"
        aria-label="Search environments"
        className="flex gap-2 items-center"
      >
        <input
          id="env-search"
          type="text"
          className="input input-sm flex-1 max-w-72"
          placeholder={orgKey ? 'Search environments…' : 'Search by org or environment…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search environments"
        />
        {hasActiveSearch && (
          <button
            type="button"
            className="btn btn-sm btn-ghost self-end"
            onClick={handleClearSearch}
            aria-label="Clear search filters"
          >
            Clear
          </button>
        )}
      </div>

      {/* ── Bulk Actions toolbar ─────────────────────────────────── */}
      {selectedKeys.size > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-base-content/70">
            {selectedKeys.size} selected
          </span>
          <div className="dropdown dropdown-bottom">
            <div
              tabIndex={0}
              role="button"
              className="btn btn-sm btn-neutral"
              aria-haspopup="true"
              aria-label="Bulk actions menu"
            >
              {bulkLoading ? (
                <>
                  <span className="loading loading-spinner loading-xs" aria-hidden="true" />
                  Working…
                </>
              ) : (
                <>
                  Bulk Actions ({selectedKeys.size})
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-3 w-3"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path
                      fillRule="evenodd"
                      d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                      clipRule="evenodd"
                    />
                  </svg>
                </>
              )}
            </div>
            <ul
              tabIndex={0}
              className="dropdown-content menu bg-base-100 rounded-box z-[10] w-56 p-2 shadow"
            >
              <li>
                <button type="button" onClick={handleBulkRedeploy} disabled={bulkLoading}>
                  Redeploy selected
                </button>
              </li>
              <li>
                <button type="button" onClick={handleBulkStop} disabled={bulkLoading} className="text-warning">
                  Stop selected
                </button>
              </li>
              <li>
                <button type="button" onClick={handleBulkDelete} disabled={bulkLoading} className="text-error">
                  Delete (decommission) selected
                </button>
              </li>
            </ul>
          </div>
        </div>
      )}

      {/* ── Bulk operation result toast ───────────────────────────────── */}
      {/* Single summary toast for the entire batch — no per-item toasts */}
      {bulkResult && (
        <div
          role="alert"
          className={['alert', bulkResultAlertType(bulkResult)].join(' ')}
        >
          <span>{formatBulkSummary(bulkResult)}</span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => setBulkResult(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── Results area ───────────────────────────────────────────────────────────── */}
      {(listState === 'idle' || listState === 'loading') && (
        <div
          role="status"
          aria-label="Loading environments"
          className="flex items-center gap-2 py-4 text-sm"
        >
          <span className="loading loading-spinner loading-sm" aria-hidden="true" />
          Loading environments…
        </div>
      )}

      {listState === 'error' && (
        <div className="flex items-center gap-2 py-4 text-sm text-base-content/60">
          <span>Could not load environments.</span>
          <button onClick={() => loadEnvs(query)} className="btn btn-xs btn-ghost">Retry</button>
        </div>
      )}

      {listState === 'ready' && envs.length === 0 && (
        <div className="text-base-content/60 py-4 text-sm">
          {hasActiveSearch
            ? 'No environments match your search. Try adjusting the filters.'
            : 'No environments yet. Use the form below to create one.'}
        </div>
      )}

      {listState === 'ready' && envs.length > 0 && (
        <>
        {/* ── Desktop / tablet: full table (md and above) ──────────────────── */}
        <div className="hidden md:block overflow-x-auto">
      <table className="table table-zebra w-full">
        <thead>
          <tr>
            <Th className="w-10">
              {/* Select-all checkbox — indeterminate when partially selected */}
              <input
                type="checkbox"
                className="checkbox checkbox-sm"
                aria-label="Select all environments"
                checked={envs.length > 0 && envs.every((r) => selectedKeys.has(`${r.org_key}/${r.env_key}`))}
                ref={(el) => {
                  if (el) {
                    const someSelected = envs.some((r) => selectedKeys.has(`${r.org_key}/${r.env_key}`));
                    const allSelected  = envs.length > 0 && envs.every((r) => selectedKeys.has(`${r.org_key}/${r.env_key}`));
                    el.indeterminate = someSelected && !allSelected;
                  }
                }}
                onChange={toggleSelectAll}
              />
            </Th>
            <Th>Environment</Th>
            <Th>Image</Th>
            <Th>Replicas</Th>
            <Th className="min-w-[200px]">Status</Th>
            <Th>Last deployed</Th>
            <Th>Retries</Th>
            <Th>Actions</Th>
          </tr>
        </thead>
        <tbody>
          {envs.map((row) => {
            const rowKey = `${row.org_key}/${row.env_key}`;
            const logsExpanded = expandedRows.has(rowKey);
            return (
              <React.Fragment key={rowKey}>
                <tr className="hover">
                  {/* Row selection checkbox */}
                  <Td className="w-10">
                    <input
                      type="checkbox"
                      className="checkbox checkbox-sm"
                      aria-label={`Select environment ${rowKey}`}
                      checked={selectedKeys.has(rowKey)}
                      onChange={() => toggleRowSelection(rowKey)}
                    />
                  </Td>

                  {/* Environment key — click to open detail page */}
                  <Td>
                    <Link
                      href={`/envs/${encodeURIComponent(row.org_key)}/${encodeURIComponent(row.env_key)}`}
                      className="whitespace-nowrap  font-medium text-primary hover:underline focus:underline focus:outline-none"
                      aria-label={`Open details for ${row.org_key}/${row.env_key}`}
                    > {row.org_key}-{row.env_key}</Link>
                  </Td>

                  {/* Image */}
                  <Td>
                  <Link
                      href={`/envs/${encodeURIComponent(row.org_key)}/${encodeURIComponent(row.env_key)}`}
                      className="font-medium text-primary hover:underline focus:underline focus:outline-none"
                      aria-label={`Open details for ${row.org_key}/${row.env_key}`}
                    >
                      {row.image}
                    </Link>
                  </Td>

                  {/* Replicas */}
                  <Td className="text-center">{row.replicas}</Td>

                  {/* Live status + log */}
                  <Td>
                    <StatusCell row={row} />
                  </Td>

                  {/* Last deploy date — relative time with absolute tooltip */}
                  <Td className="whitespace-nowrap text-base-content/60">
                    {(() => {
                      const iso = row.live?.last_deploy_date ?? row.last_deploy_date;
                      return (
                        <span title={formatDate(iso)}>
                          {formatRelativeTime(iso)}
                        </span>
                      );
                    })()}
                  </Td>

                  {/* Retry indicator */}
                  <Td className="whitespace-nowrap">
                    <RetryCell row={row} />
                  </Td>

                  {/* Actions */}
                  <Td>
                    <ActionsCell
                      row={row}
                      onStop={stopEnv}
                      onDecommission={decommissionEnvCallback}
                      onDelete={setDeleteEnv}
                      onToggleLogs={toggleLogs}
                      logsExpanded={logsExpanded}
                    />
                  </Td>
                </tr>

                {/* Expanded log panel row */}
                {logsExpanded && (
                  <tr className="bg-base-200/40">
                    <td colSpan={9} className="px-4 py-3">
                      <DeploymentLogPanel
                        org_key={row.org_key}
                        env_key={row.env_key}
                        limit={50}
                        className="shadow-none border-base-300"
                      />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>

        {/* ── Mobile: stacked cards (below md) ──────────────────────────── */}
        <div className="flex flex-col gap-3 md:hidden">
          {envs.length > 1 && (
            <div className="flex items-center gap-2 px-1">
              <input
                type="checkbox"
                className="checkbox checkbox-sm"
                aria-label="Select all environments"
                checked={envs.length > 0 && envs.every((r) => selectedKeys.has(`${r.org_key}/${r.env_key}`))}
                ref={(el) => {
                  if (el) {
                    const someSelected = envs.some((r) => selectedKeys.has(`${r.org_key}/${r.env_key}`));
                    const allSelected  = envs.length > 0 && envs.every((r) => selectedKeys.has(`${r.org_key}/${r.env_key}`));
                    el.indeterminate = someSelected && !allSelected;
                  }
                }}
                onChange={toggleSelectAll}
              />
              <span className="text-xs text-base-content/60">Select all</span>
            </div>
          )}

          {envs.map((row) => {
            const rowKey = `${row.org_key}/${row.env_key}`;
            const logsExpanded = expandedRows.has(rowKey);
            const liveStatus = row.live?.deploy_status ?? row.deploy_status;
            const canStop = isStoppable(liveStatus);
            const canDecommission = isDecommissionable(liveStatus);
            const deployIso = row.live?.last_deploy_date ?? row.last_deploy_date;

            return (
              <div
                key={rowKey}
                className={`card border border-base-300 bg-base-100 shadow-sm${selectedKeys.has(rowKey) ? ' border-primary' : ''}`}
              >
                <div className="card-body p-4 gap-3">
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="checkbox checkbox-sm mt-0.5 shrink-0"
                      aria-label={`Select environment ${rowKey}`}
                      checked={selectedKeys.has(rowKey)}
                      onChange={() => toggleRowSelection(rowKey)}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <span className="font-semibold text-sm text-nowrap">{row.org_key}-{row.env_key}</span>
                        <StatusCell row={row} />
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1 text-xs text-base-content/70">
                    <div>
                      <span className="font-semibold">Image: </span>
                      {row.image}asdsadsa
                    </div>
                    <div>
                      <span className="font-semibold">Replicas: </span>
                      {row.replicas}
                    </div>
                    {deployIso && (
                      <div>
                        <span className="font-semibold">Deployed: </span>
                        <span title={formatDate(deployIso)}>{formatRelativeTime(deployIso)}</span>
                      </div>
                    )}
                    {(row.live?.stop_date ?? row.stop_date) && (
                      <div>
                        <span className="font-semibold text-orange-600">Stopped: </span>
                        <span title={formatDate(row.live?.stop_date ?? row.stop_date)}>
                          {formatRelativeTime(row.live?.stop_date ?? row.stop_date)}
                        </span>
                      </div>
                    )}
                  </div>

                  {(row.live?.current_retry_count ?? 0) > 0 && (
                    <div><RetryCell row={row} /></div>
                  )}

                  <div className="flex flex-wrap gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => toggleLogs(row.org_key, row.env_key)}
                      className={`btn btn-xs${logsExpanded ? ' btn-primary' : ' btn-ghost'}`}
                      aria-expanded={logsExpanded}
                    >
                      {logsExpanded ? '▾ Logs' : '▸ Logs'}
                    </button>
                    {(canStop || row.stopping) && (
                      <button
                        type="button"
                        disabled={row.stopping}
                        onClick={() => stopEnv(row.org_key, row.env_key)}
                        className="btn btn-xs btn-warning"
                        title="Scale to 0 replicas"
                      >
                        {row.stopping ? (
                          <><span className="loading loading-spinner loading-xs" />Stopping…</>
                        ) : 'Stop'}
                      </button>
                    )}
                    {(canDecommission || row.decommissioning) && (
                      <button
                        type="button"
                        disabled={row.decommissioning}
                        onClick={() => decommissionEnvCallback(row.org_key, row.env_key)}
                        className="btn btn-xs btn-error"
                        title="Permanently destroy this environment"
                      >
                        {row.decommissioning ? (
                          <><span className="loading loading-spinner loading-xs" />Scheduling…</>
                        ) : 'Decommission'}
                      </button>
                    )}
                    {row.stopError && (
                      <p className="w-full text-xs text-error">{row.stopError}</p>
                    )}
                    {row.decommissionError && (
                      <p className="w-full text-xs text-error">{row.decommissionError}</p>
                    )}
                  </div>

                  {logsExpanded && (
                    <DeploymentLogPanel
                      org_key={row.org_key}
                      env_key={row.env_key}
                      limit={50}
                      className="shadow-none border-base-300"
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
        </>
      )}

      {/* ── Bulk action confirmation modal ──────────────────────────────── */}
      {/* Single DaisyUI dialog — opened by handleBulkRedeploy/handleBulkDelete,
          confirmed by executeBulkAction. Constraint: one dialog per batch. */}
      {toast && <Toast message={toast.message} type={toast.type} onClose={clearToast} />}

      {/* ── Single-env delete confirmation ─────────────────────────────────── */}
      <ConfirmDeleteModal
        open={deleteEnv !== null}
        title={`Delete "${deleteEnv?.org_key}/${deleteEnv?.env_key}"?`}
        message={
          deleteEnv?.deploy_status === 'decommissioned'
            ? 'This environment is already decommissioned. It will be permanently removed from the database.'
            : 'This will decommission the environment (removing all Kubernetes, Postgres, and OpenSearch resources) and then permanently delete it.'
        }
        confirmLabel="Delete"
        onClose={() => setDeleteEnv(null)}
        onConfirm={async () => {
          const env = deleteEnv!;
          const res = await fetch(
            `/api/envs/${encodeURIComponent(env.org_key)}/delete?env_key=${encodeURIComponent(env.env_key)}`,
            { method: 'DELETE' }
          );
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error((body as { error?: string }).error ?? `Server error ${res.status}`);
          }
          // 204 = immediately deleted; 202 = decommission queued (update status in list)
          if (res.status === 204) {
            setEnvs((prev) => prev.filter((r) => !(r.org_key === env.org_key && r.env_key === env.env_key)));
          } else {
            const { env: updated } = await res.json();
            setEnvs((prev) => prev.map((r) =>
              r.org_key === env.org_key && r.env_key === env.env_key
                ? { ...r, ...(updated ?? {}), deploy_status: 'decommissioning' }
                : r
            ));
          }
        }}
      />

      {bulkConfirmPending && (() => {
        const { title, body } = bulkConfirmMessage(
          bulkConfirmPending.action,
          bulkConfirmPending.keys.length
        );
        return (
          <dialog
            open
            aria-modal="true"
            aria-labelledby="bulk-confirm-title"
            className="modal modal-open"
          >
            <div className="modal-box overflow-hidden">
              <h3
                id="bulk-confirm-title"
                className="font-bold text-lg"
              >
                {title}
              </h3>
              <p className="py-4 text-sm">{body}</p>
              <div className="modal-action">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setBulkConfirmPending(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={
                    bulkConfirmPending.action === 'delete' ? 'btn btn-error'
                    : bulkConfirmPending.action === 'stop' ? 'btn btn-warning'
                    : 'btn btn-primary'
                  }
                  onClick={executeBulkAction}
                >
                  {bulkConfirmPending.action === 'delete'
                    ? `Decommission ${bulkConfirmPending.keys.length}`
                    : bulkConfirmPending.action === 'stop'
                    ? `Stop ${bulkConfirmPending.keys.length}`
                    : `Redeploy ${bulkConfirmPending.keys.length}`}
                </button>
              </div>
            </div>
            {/* Backdrop — click to cancel */}
            <div
              className="modal-backdrop"
              role="presentation"
              onClick={() => setBulkConfirmPending(null)}
            />
          </dialog>
        );
      })()}
    </div>
  );
}
