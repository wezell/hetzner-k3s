import React from 'react';

export type DeployStatus =
  | 'pending'
  | 'provisioning'
  | 'deployed'
  | 'reconfiguring'
  | 'stopping'
  | 'failed'
  | 'stopped'
  | 'decommissioning'
  | 'decommissioned';

interface StatusBadgeProps {
  status: DeployStatus | string;
  className?: string;
}

/**
 * Visual configuration for each deployment state.
 *
 * - `label`      Human-readable text shown inside the badge.
 * - `classes`    Tailwind classes for background + text (light + dark).
 * - `dot`        Tailwind classes for the coloured dot indicator.
 * - `animated`   When true the dot pulses, conveying an in-progress transition.
 */
export interface StatusConfig {
  label: string;
  classes: string;
  dot: string;
  animated: boolean;
}

/**
 * Exported so tests can assert against the raw configuration without needing
 * a DOM renderer.  Do not mutate at runtime.
 */
export const STATUS_CONFIG: Record<DeployStatus, StatusConfig> = {
  pending: {
    label: 'Pending',
    classes: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300',
    dot: 'bg-yellow-500 dark:bg-yellow-400',
    animated: false,
  },
  provisioning: {
    label: 'Provisioning',
    classes: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
    dot: 'bg-blue-500 dark:bg-blue-400',
    animated: true,
  },
  deployed: {
    label: 'Deployed',
    classes: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    dot: 'bg-green-500 dark:bg-green-400',
    animated: false,
  },
  reconfiguring: {
    label: 'Reconfiguring',
    classes: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
    dot: 'bg-purple-500 dark:bg-purple-400',
    animated: true,
  },
  stopping: {
    label: 'Stopping',
    classes: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
    dot: 'bg-orange-500 dark:bg-orange-400',
    animated: true,
  },
  failed: {
    label: 'Failed',
    classes: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    dot: 'bg-red-500 dark:bg-red-400',
    animated: false,
  },
  stopped: {
    label: 'Stopped',
    classes: 'bg-gray-100 text-gray-700 dark:bg-gray-700/60 dark:text-gray-300',
    dot: 'bg-gray-400 dark:bg-gray-500',
    animated: false,
  },
  decommissioning: {
    label: 'Decommissioning',
    classes: 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300',
    dot: 'bg-teal-500 dark:bg-teal-400',
    animated: true,
  },
  decommissioned: {
    label: 'Decommissioned',
    classes: 'bg-slate-200 text-slate-600 dark:bg-slate-700/60 dark:text-slate-400',
    dot: 'bg-slate-400 dark:bg-slate-500',
    animated: false,
  },
};

/**
 * Fallback for any status string not present in STATUS_CONFIG (e.g. a future
 * state added to the DB before the UI is updated).
 */
export const FALLBACK_CONFIG = {
  label: (s: string) => s.charAt(0).toUpperCase() + s.slice(1),
  classes: 'bg-gray-100 text-gray-600 dark:bg-gray-700/60 dark:text-gray-400',
  dot: 'bg-gray-400',
  animated: false,
} as const;

/**
 * StatusBadge
 *
 * Compact pill badge that communicates an environment's current lifecycle
 * state at a glance.
 *
 * Visual language:
 *   - Static  states (pending, deployed, failed, stopped, decommissioned): solid dot.
 *   - Active  states (provisioning, reconfiguring, stopping): pulsing dot signals
 *     that the worker is actively changing something.
 *
 * Supports every value in {@link DeployStatus}, plus an unknown-string fallback
 * so new DB states never cause a render error.
 */
export function StatusBadge({ status, className = '' }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status as DeployStatus];

  const label = config ? config.label : FALLBACK_CONFIG.label(status);
  const colorClasses = config ? config.classes : FALLBACK_CONFIG.classes;
  const dotClasses = config ? config.dot : FALLBACK_CONFIG.dot;
  const animated = config ? config.animated : FALLBACK_CONFIG.animated;

  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
        colorClasses,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label={`Status: ${label}`}
    >
      {/* Coloured dot indicator */}
      <span
        className={[
          'h-1.5 w-1.5 rounded-full flex-shrink-0',
          dotClasses,
          animated ? 'animate-pulse' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}
