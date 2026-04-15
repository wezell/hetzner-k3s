'use client';

import { useEffect, useRef } from 'react';
import { DeploymentLogPanel, buildLogsUrl } from './DeploymentLogPanel';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeploymentLogModalProps {
  /** Whether the modal is open */
  open: boolean;
  /** Called when the modal should close (cancel or backdrop click) */
  onClose: () => void;
  /** Organization key — forwarded to DeploymentLogPanel */
  org_key: string;
  /** Environment key — forwarded to DeploymentLogPanel */
  env_key: string;
  /** Max log entries per page (default 50, passed through to panel) */
  limit?: number;
  /** Poll interval in ms (default 5000, passed through to panel) */
  pollInterval?: number;
}

// ---------------------------------------------------------------------------
// Helper — exported for testability
// ---------------------------------------------------------------------------

/**
 * Build the modal title from org and env keys.
 * Exported so tests can validate formatting without rendering.
 */
export function buildModalTitle(org_key: string, env_key: string): string {
  return `Deployment Logs — ${org_key}/${env_key}`;
}

// Re-export buildLogsUrl so tests can import from a single component file
export { buildLogsUrl };

// ---------------------------------------------------------------------------
// DeploymentLogModal
// ---------------------------------------------------------------------------

/**
 * DeploymentLogModal
 *
 * Wraps DeploymentLogPanel in a DaisyUI modal dialog.  The panel handles all
 * loading/error/polling state internally; this component only owns the open/close
 * lifecycle of the native <dialog> element.
 *
 * Features:
 * - Native <dialog> with DaisyUI `modal` classes (corporate theme)
 * - Backdrop click and Escape key both trigger onClose
 * - Wide modal-box (max-w-4xl) to accommodate log content
 * - Header with org/env context and close button
 * - DeploymentLogPanel mounted only when open (avoids polling when hidden)
 */
export default function DeploymentLogModal({
  open,
  onClose,
  org_key,
  env_key,
  limit = 50,
  pollInterval = 5_000,
}: DeploymentLogModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Sync open prop with native dialog show/close
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Handle native dialog close event (Escape key)
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handler = () => onClose();
    dialog.addEventListener('close', handler);
    return () => dialog.removeEventListener('close', handler);
  }, [onClose]);

  const title = buildModalTitle(org_key, env_key);

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      aria-labelledby="deployment-log-modal-title"
    >
      {/* Backdrop click closes */}
      <div className="modal-backdrop" onClick={onClose} />

      <div className="modal-box w-full max-w-4xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3
            id="deployment-log-modal-title"
            className="text-lg font-bold font-mono"
          >
            {title}
          </h3>
          <button
            type="button"
            className="btn btn-sm btn-circle btn-ghost"
            onClick={onClose}
            aria-label="Close deployment log modal"
          >
            ✕
          </button>
        </div>

        {/* Log panel — only mounted when open so polling stops when modal is closed */}
        {open && (
          <DeploymentLogPanel
            org_key={org_key}
            env_key={env_key}
            limit={limit}
            pollInterval={pollInterval}
          />
        )}
      </div>
    </dialog>
  );
}
