'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CustomerEnv, DeploymentLog, DeployStatus } from '@/db/types';
import { StatusBadge } from '@/components/StatusBadge';

// ---------------------------------------------------------------------------
// TypeScript interfaces for environment data shape
// ---------------------------------------------------------------------------

/**
 * Raw status snapshot returned by GET /api/envs/[id]/status.
 * Mirrors the StatusResponse type in the route handler.
 */
export interface EnvironmentStatusSnapshot {
  org_key: string;
  env_key: string;
  deploy_status: DeployStatus;
  last_deploy_date: string | null;
  stop_date: string | null;
  dcomm_date: string | null;
  mod_date: string;
  /** How many retries the worker has attempted since last success (0–3). */
  current_retry_count: number;
  logs: DeploymentLog[];
}

/**
 * A single row in the dashboard table.
 *
 * Extends CustomerEnv with a live status snapshot that is fetched and refreshed
 * on a polling interval. While a status fetch is in flight `polling` is true.
 * If the fetch has never succeeded, `snapshot` is null.
 */
export interface EnvironmentDashboardRow extends CustomerEnv {
  /** Latest live status from the API, or null before the first fetch. */
  snapshot: EnvironmentStatusSnapshot | null;
  /** True while a status fetch is in-flight for this row. */
  polling: boolean;
}

/**
 * Props accepted by the EnvironmentStatusDashboard component.
 */
export interface EnvironmentStatusDashboardProps {
  /**
   * Increment this value to force a full re-fetch of the environment list
   * (e.g. after provisioning a new environment).
   */
  refreshKey?: number;
  /**
   * How often (in ms) to refresh each row's live status.
   * Defaults to 30 000 ms (30 s), aligned with the worker poll interval.
   */
  pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(iso: string | null | undefined): string {
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
 * Returns a Tailwind colour class for the retry-count badge.
 *   0      → grey  (no retries)
 *   1      → amber (first retry, watch)
 *   2      → orange (second retry, warn)
 *   3+     → red   (at cap, needs intervention)
 */
function retryBadgeClass(count: number): string {
  if (count === 0) return 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400';
  if (count === 1) return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300';
  if (count === 2) return 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300';
  return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300';
}

// ---------------------------------------------------------------------------
// Primitive sub-components
// ---------------------------------------------------------------------------

function Spinner({ small = false }: { small?: boolean }) {
  const sz = small ? 'h-3 w-3' : 'h-4 w-4';
  return (
    <svg
      className={`${sz} animate-spin text-zinc-400`}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function Th({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={[
        'whitespace-nowrap px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide',
        'text-zinc-500 dark:text-zinc-400',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
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
    <td
      className={[
        'px-4 py-3 align-top text-sm text-zinc-700 dark:text-zinc-300',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </td>
  );
}

// ---------------------------------------------------------------------------
// Retry-count badge
// ---------------------------------------------------------------------------

function RetryBadge({ count }: { count: number | undefined }) {
  const n = count ?? 0;
  return (
    <span
      className={[
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        retryBadgeClass(n),
      ].join(' ')}
      title={n >= 3 ? 'At retry cap — manual intervention required' : undefined}
    >
      {n}
      {n >= 3 && (
        <span className="ml-1" aria-label="Needs intervention">
          ⚠
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Status cell — badge + spinner during live fetch
// ---------------------------------------------------------------------------

function StatusCell({ row }: { row: EnvironmentDashboardRow }) {
  // Prefer live snapshot status; fall back to DB row status
  const status = row.snapshot?.deploy_status ?? row.deploy_status;

  if (row.polling && !row.snapshot) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
        <Spinner small />
        Fetching…
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <StatusBadge status={status} />
      {row.polling && <Spinner small />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Log summary cell — latest log entry for quick glance
// ---------------------------------------------------------------------------

function LatestLogCell({ row }: { row: EnvironmentDashboardRow }) {
  const log = row.snapshot?.logs?.[0];
  if (!log) {
    return <span className="text-xs text-zinc-400">—</span>;
  }

  const statusColors: Record<DeploymentLog['status'], string> = {
    success: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    retrying: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  };

  return (
    <div className="space-y-0.5">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span
          className={[
            'inline-flex items-center rounded-full px-1.5 py-0.5 font-medium',
            statusColors[log.status] ?? 'bg-zinc-100 text-zinc-600',
          ].join(' ')}
        >
          {log.status}
        </span>
        <span className="font-medium capitalize text-zinc-600 dark:text-zinc-400">
          {log.action}
        </span>
      </div>
      {log.error_detail && (
        <p className="max-w-xs truncate font-mono text-xs text-red-600 dark:text-red-400">
          {log.error_detail}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard table row
// ---------------------------------------------------------------------------

function DashboardRow({ row }: { row: EnvironmentDashboardRow }) {
  const retryCount = row.snapshot?.current_retry_count;

  return (
    <tr
      key={`${row.org_key}/${row.env_key}`}
      className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/40"
    >
      {/* Environment / Org */}
      <Td>
        <div className="font-mono font-semibold text-zinc-900 dark:text-zinc-100">
          {row.env_key}
        </div>
        <div className="mt-0.5 text-xs text-zinc-400">{row.org_key}</div>
      </Td>

      {/* Live status badge */}
      <Td>
        <StatusCell row={row} />
      </Td>

      {/* Retry count */}
      <Td className="text-center">
        <RetryBadge count={retryCount} />
      </Td>

      {/* Latest log */}
      <Td className="min-w-[220px]">
        <LatestLogCell row={row} />
      </Td>

      {/* Timestamps */}
      <Td className="whitespace-nowrap text-xs text-zinc-500 dark:text-zinc-400">
        {fmtDate(row.snapshot?.last_deploy_date ?? row.last_deploy_date)}
      </Td>
      <Td className="whitespace-nowrap text-xs text-zinc-500 dark:text-zinc-400">
        {fmtDate(row.snapshot?.stop_date ?? row.stop_date)}
      </Td>
      <Td className="whitespace-nowrap text-xs text-zinc-500 dark:text-zinc-400">
        {fmtDate(row.snapshot?.dcomm_date ?? row.dcomm_date)}
      </Td>
      <Td className="whitespace-nowrap text-xs text-zinc-500 dark:text-zinc-400">
        {fmtDate(row.created_date)}
      </Td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Main EnvironmentStatusDashboard component
// ---------------------------------------------------------------------------

/**
 * EnvironmentStatusDashboard
 *
 * Operator-facing dashboard that displays all customer environments in a table
 * with live-polled status, retry count, and all lifecycle timestamps.
 *
 * Data flow:
 *   1. On mount (and when refreshKey changes): fetch /api/envs to get the full
 *      list of CustomerEnv rows.
 *   2. On each pollIntervalMs tick: hit /api/envs/[org_key]/status?env_key=…
 *      for every visible row and update the snapshot in place.
 *
 * This component is the shell for the operator dashboard.  Additional features
 * (manual intervention controls, log drawer, filtering) will be layered on top
 * in subsequent work.
 */
export default function EnvironmentStatusDashboard({
  refreshKey = 0,
  pollIntervalMs = 30_000,
}: EnvironmentStatusDashboardProps) {
  const [rows, setRows] = useState<EnvironmentDashboardRow[]>([]);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);

  // Keep a ref to the latest rows so interval callbacks see fresh data
  const rowsRef = useRef<EnvironmentDashboardRow[]>([]);
  rowsRef.current = rows;

  const listAbortRef = useRef<AbortController | null>(null);
  const statusAbortsRef = useRef<Map<string, AbortController>>(new Map());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Fetch live status for one environment row ─────────────────────────────

  const fetchRowStatus = useCallback(async (orgKey: string, envKey: string) => {
    const key = `${orgKey}/${envKey}`;

    // Cancel any previous in-flight fetch for this row
    statusAbortsRef.current.get(key)?.abort();
    const ctrl = new AbortController();
    statusAbortsRef.current.set(key, ctrl);

    // Mark row as polling
    setRows((prev) =>
      prev.map((r) =>
        r.org_key === orgKey && r.env_key === envKey ? { ...r, polling: true } : r
      )
    );

    try {
      const res = await fetch(
        `/api/envs/${encodeURIComponent(orgKey)}/status?env_key=${encodeURIComponent(envKey)}&limit=5`,
        { signal: ctrl.signal }
      );

      if (!res.ok) {
        // Non-2xx — clear polling flag but keep previous snapshot
        setRows((prev) =>
          prev.map((r) =>
            r.org_key === orgKey && r.env_key === envKey ? { ...r, polling: false } : r
          )
        );
        return;
      }

      const snapshot: EnvironmentStatusSnapshot = await res.json();
      setRows((prev) =>
        prev.map((r) =>
          r.org_key === orgKey && r.env_key === envKey
            ? { ...r, snapshot, polling: false }
            : r
        )
      );
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setRows((prev) =>
        prev.map((r) =>
          r.org_key === orgKey && r.env_key === envKey ? { ...r, polling: false } : r
        )
      );
    }
  }, []);

  // ── Poll all visible rows ─────────────────────────────────────────────────

  const pollAll = useCallback(() => {
    for (const row of rowsRef.current) {
      fetchRowStatus(row.org_key, row.env_key);
    }
  }, [fetchRowStatus]);

  // ── Load the environment list ─────────────────────────────────────────────

  const loadEnvs = useCallback(async () => {
    listAbortRef.current?.abort();
    const ctrl = new AbortController();
    listAbortRef.current = ctrl;

    setLoadState('loading');
    setLoadError(null);

    try {
      const res = await fetch('/api/envs', { signal: ctrl.signal });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setLoadError((body as { error?: string }).error ?? `Server error ${res.status}`);
        setLoadState('error');
        return;
      }

      const envs: CustomerEnv[] = await res.json();
      setRows(
        envs.map((env) => ({
          ...env,
          snapshot: null,
          polling: false,
        }))
      );
      setLoadState('ready');
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setLoadError('Network error — could not load environments.');
      setLoadState('error');
    }
  }, []);

  // ── Effects ───────────────────────────────────────────────────────────────

  // Re-load list whenever refreshKey changes
  useEffect(() => {
    loadEnvs();
    return () => listAbortRef.current?.abort();
  }, [refreshKey, loadEnvs]);

  // Start polling once list is ready
  useEffect(() => {
    if (loadState !== 'ready') return;

    // Immediate first poll
    pollAll();

    timerRef.current = setInterval(pollAll, pollIntervalMs);

    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current);
      for (const ctrl of statusAbortsRef.current.values()) ctrl.abort();
      statusAbortsRef.current.clear();
    };
  }, [loadState, pollAll, pollIntervalMs, rows.length]);

  // ── Loading state ─────────────────────────────────────────────────────────

  if (loadState === 'idle' || loadState === 'loading') {
    return (
      <div
        role="status"
        aria-label="Loading environments"
        className="flex items-center gap-2 py-6 text-sm text-zinc-500 dark:text-zinc-400"
      >
        <Spinner />
        Loading environments…
      </div>
    );
  }

  // ── Error state ───────────────────────────────────────────────────────────

  if (loadState === 'error') {
    return (
      <div
        role="alert"
        className="flex items-center gap-3 rounded-md border border-red-200 bg-red-50 p-4 text-sm dark:border-red-800 dark:bg-red-950"
      >
        <p className="text-red-700 dark:text-red-300">{loadError}</p>
        <button
          type="button"
          onClick={loadEnvs}
          className="ml-auto shrink-0 font-medium text-red-700 underline hover:no-underline dark:text-red-300"
        >
          Retry
        </button>
      </div>
    );
  }

  // ── Empty state ───────────────────────────────────────────────────────────

  if (rows.length === 0) {
    return (
      <p className="py-6 text-sm text-zinc-500 dark:text-zinc-400">
        No environments found.
      </p>
    );
  }

  // ── Dashboard table ───────────────────────────────────────────────────────

  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="w-full min-w-[900px] text-sm">
        <thead>
          <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
            <Th>Environment</Th>
            <Th>Status</Th>
            <Th className="text-center">Retries</Th>
            <Th>Latest log</Th>
            <Th>Last deployed</Th>
            <Th>Stop date</Th>
            <Th>Decommission date</Th>
            <Th>Created</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <DashboardRow key={`${row.org_key}/${row.env_key}`} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
