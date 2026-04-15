import React from 'react';
import type { DeployStatus } from '@/db/types';

// ---------------------------------------------------------------------------
// Status metadata
// ---------------------------------------------------------------------------

interface StatusMeta {
  label: string;
  /** DaisyUI badge variant class */
  badgeClass: string;
  /** DaisyUI alert variant class used for the panel background */
  alertClass: string;
  /** Icon rendered beside the label */
  icon: React.ReactNode;
  /** When true, render a pulsing ring to signal work-in-progress */
  animated: boolean;
  /** Short description shown below the label */
  description: string;
}

function PulsingDot({ colorClass }: { colorClass: string }) {
  return (
    <span className="relative flex h-3 w-3">
      <span
        className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${colorClass}`}
      />
      <span className={`relative inline-flex rounded-full h-3 w-3 ${colorClass}`} />
    </span>
  );
}

function StaticDot({ colorClass }: { colorClass: string }) {
  return <span className={`inline-flex rounded-full h-3 w-3 ${colorClass}`} />;
}

const STATUS_META: Record<DeployStatus, StatusMeta> = {
  pending: {
    label: 'Pending',
    badgeClass: 'badge-warning',
    alertClass: 'alert-warning',
    icon: <StaticDot colorClass="bg-warning" />,
    animated: false,
    description: 'Queued for provisioning',
  },
  provisioning: {
    label: 'Provisioning',
    badgeClass: 'badge-info',
    alertClass: 'alert-info',
    icon: <PulsingDot colorClass="bg-info" />,
    animated: true,
    description: 'Worker is setting up Kubernetes resources',
  },
  deployed: {
    label: 'Running',
    badgeClass: 'badge-success',
    alertClass: 'alert-success',
    icon: <StaticDot colorClass="bg-success" />,
    animated: false,
    description: 'Environment is live and serving traffic',
  },
  reconfiguring: {
    label: 'Reconfiguring',
    badgeClass: 'badge-info',
    alertClass: 'alert-info',
    icon: <PulsingDot colorClass="bg-info" />,
    animated: true,
    description: 'Applying configuration changes',
  },
  stopping: {
    label: 'Stopping',
    badgeClass: 'badge-warning',
    alertClass: 'alert-warning',
    icon: <PulsingDot colorClass="bg-warning" />,
    animated: true,
    description: 'Scaling down to zero replicas',
  },
  failed: {
    label: 'Failed',
    badgeClass: 'badge-error',
    alertClass: 'alert-error',
    icon: <StaticDot colorClass="bg-error" />,
    animated: false,
    description: 'Last operation failed — manual intervention may be required',
  },
  stopped: {
    label: 'Stopped',
    badgeClass: 'badge-neutral',
    alertClass: '',
    icon: <StaticDot colorClass="bg-neutral" />,
    animated: false,
    description: 'Environment is scaled to zero',
  },
  decommissioning: {
    label: 'Decommissioning',
    badgeClass: 'badge-error',
    alertClass: 'alert-error',
    icon: <PulsingDot colorClass="bg-error" />,
    animated: true,
    description: 'Tearing down all resources — this cannot be undone',
  },
  decommissioned: {
    label: 'Decommissioned',
    badgeClass: 'badge-neutral',
    alertClass: '',
    icon: <StaticDot colorClass="bg-neutral" />,
    animated: false,
    description: 'All resources have been permanently removed',
  },
};

const FALLBACK_META: StatusMeta = {
  label: 'Unknown',
  badgeClass: 'badge-neutral',
  alertClass: '',
  icon: <StaticDot colorClass="bg-neutral" />,
  animated: false,
  description: 'Status not recognised',
};

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

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diffMs = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diffMs);
  if (abs < 60_000) return 'just now';
  if (abs < 3_600_000) return `${Math.floor(abs / 60_000)}m ago`;
  if (abs < 86_400_000) return `${Math.floor(abs / 3_600_000)}h ago`;
  if (abs < 30 * 86_400_000) return `${Math.floor(abs / 86_400_000)}d ago`;
  return formatDate(iso);
}

function retryBadgeClass(count: number): string {
  if (count === 0) return 'badge-neutral';
  if (count === 1) return 'badge-warning';
  if (count === 2) return 'badge-warning';
  return 'badge-error';
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DeploymentStatusPanelProps {
  /** Current deployment status from DB or live poll */
  deployStatus: DeployStatus | string | null | undefined;
  /** Number of worker retries since last success (0 = no retries) */
  retryCount?: number | null;
  /** ISO timestamp of the last successful deploy */
  lastDeployDate?: string | null;
  /** ISO timestamp of the last status poll (to show freshness) */
  lastPolledAt?: string | null;
  /** True while a live status fetch is in-flight */
  isPolling?: boolean;
  /** Extra CSS classes on the root element */
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * DeploymentStatusPanel
 *
 * Prominent status display card for the environment detail page.
 *
 * Visual language:
 *   - Static states (pending, deployed, failed, stopped, decommissioned):
 *     solid coloured dot.
 *   - Active/transitioning states (provisioning, reconfiguring, stopping,
 *     decommissioning): pulsing dot to signal the worker is actively changing
 *     something.
 *
 * Uses DaisyUI corporate theme components (alert, badge, stats) with no
 * custom Tailwind colour names — every colour token is a DaisyUI semantic
 * token (success, warning, error, info, neutral).
 */
export function DeploymentStatusPanel({
  deployStatus,
  retryCount,
  lastDeployDate,
  lastPolledAt,
  isPolling = false,
  className = '',
}: DeploymentStatusPanelProps) {
  const meta =
    deployStatus != null
      ? (STATUS_META[deployStatus as DeployStatus] ?? {
          ...FALLBACK_META,
          label:
            String(deployStatus).charAt(0).toUpperCase() +
            String(deployStatus).slice(1),
        })
      : null;

  const retries = retryCount ?? 0;

  // ── Loading skeleton ────────────────────────────────────────────────────
  if (meta === null) {
    return (
      <div
        role="status"
        aria-label="Loading deployment status"
        className={`card bg-base-100 border border-base-300 shadow-sm ${className}`}
      >
        <div className="card-body p-4 flex flex-row items-center gap-3">
          <span className="loading loading-spinner loading-sm" aria-hidden="true" />
          <span className="text-sm text-base-content/60">Loading status…</span>
        </div>
      </div>
    );
  }

  const hasAlert = Boolean(meta.alertClass);

  return (
    <div
      className={`card bg-base-100 border border-base-300 shadow-sm ${className}`}
      data-testid="deployment-status-panel"
    >
      <div className="card-body p-4 gap-4">
        {/* ── Primary status row ──────────────────────────────────────── */}
        <div
          className={`alert ${meta.alertClass} py-3`}
          role="status"
          aria-label={`Deployment status: ${meta.label}`}
        >
          <div className="flex items-center gap-3">
            {/* Animated or static dot */}
            <span className="flex-shrink-0" aria-hidden="true">
              {meta.icon}
            </span>

            <div className="flex-1 min-w-0">
              <p className="font-semibold leading-none">{meta.label}</p>
              <p className="text-sm opacity-80 mt-0.5 leading-snug">
                {meta.description}
              </p>
            </div>

            {/* Spinner during live poll */}
            {isPolling && (
              <span
                className="loading loading-spinner loading-xs opacity-60 flex-shrink-0"
                aria-label="Refreshing status"
              />
            )}
          </div>
        </div>

        {/* ── Stats row ───────────────────────────────────────────────── */}
        <div className="stats stats-horizontal shadow-none border border-base-200 rounded-lg w-full text-sm divide-x divide-base-200 overflow-hidden">
          {/* Last deployed */}
          <div className="stat p-3 min-w-0">
            <div className="stat-title text-xs">Last deployed</div>
            <div
              className="stat-value text-base font-medium"
              title={formatDate(lastDeployDate)}
            >
              {formatRelativeTime(lastDeployDate)}
            </div>
          </div>

          {/* Retry count */}
          <div className="stat p-3 min-w-0">
            <div className="stat-title text-xs">Retries</div>
            <div className="stat-value text-base font-medium flex items-center gap-1.5">
              <span
                className={`badge ${retryBadgeClass(retries)} badge-sm`}
                title={retries >= 3 ? 'At retry cap — intervention required' : undefined}
              >
                {retries}
              </span>
              {retries >= 3 && (
                <span
                  className="text-error text-xs font-semibold"
                  aria-label="Retry limit reached"
                >
                  ⚠ cap
                </span>
              )}
            </div>
          </div>

          {/* Status freshness */}
          <div className="stat p-3 min-w-0">
            <div className="stat-title text-xs">Status as of</div>
            <div
              className="stat-value text-base font-medium"
              title={formatDate(lastPolledAt)}
            >
              {isPolling ? (
                <span className="flex items-center gap-1">
                  <span className="loading loading-dots loading-xs" aria-hidden="true" />
                  <span className="sr-only">Polling…</span>
                </span>
              ) : (
                formatRelativeTime(lastPolledAt)
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
