'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import type { CustomerEnv, CustomerOrg } from '@/db/types';
import { DEFAULTS, REGION_OPTIONS } from './EnvForm';
import { useToast } from '@/hooks/useToast';
import Toast from '@/components/Toast';

export interface CreateEnvModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: (env: CustomerEnv) => void;
  /** When provided, org_key is pre-filled and locked. */
  orgKey?: string;
}

export default function CreateEnvModal({ open, onClose, onSuccess, orgKey }: CreateEnvModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const [submitting, setSubmitting] = useState(false);
  const { toast, showToast, clearToast } = useToast();

  // Env vars editor rows — pre-populated from DEFAULTS
  const [envVarRows, setEnvVarRows] = useState<{ k: string; v: string }[]>(
    () => Object.entries(DEFAULTS.env_vars ?? {}).map(([k, v]) => ({ k, v }))
  );

  // Org dropdown state (only when orgKey not pre-set)
  const [orgs, setOrgs] = useState<CustomerOrg[]>([]);
  const [orgsLoading, setOrgsLoading] = useState(false);
  const [orgsError, setOrgsError] = useState<string | null>(null);

  // ── Dialog open/close ─────────────────────────────────────────────────────

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handler = () => { if (!submitting) onClose(); };
    dialog.addEventListener('close', handler);
    return () => dialog.removeEventListener('close', handler);
  }, [onClose, submitting]);

  // ── Org list ──────────────────────────────────────────────────────────────

  const fetchOrgs = useCallback(() => {
    if (orgKey) return;
    setOrgsLoading(true);
    setOrgsError(null);
    fetch('/api/orgs')
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((data: CustomerOrg[]) => setOrgs(data))
      .catch(() => setOrgsError('Failed to load organizations.'))
      .finally(() => setOrgsLoading(false));
  }, [orgKey]);

  useEffect(() => {
    if (open && !orgKey) fetchOrgs();
  }, [open, orgKey, fetchOrgs]);

  // ── Reset / close ─────────────────────────────────────────────────────────

  function handleClose() {
    if (submitting) return;
    formRef.current?.reset();
    clearToast();
    setEnvVarRows(Object.entries(DEFAULTS.env_vars ?? {}).map(([k, v]) => ({ k, v })));
    onClose();
  }

  // ── Env vars rows ─────────────────────────────────────────────────────────

  function commitRows(next: { k: string; v: string }[]) {
    setEnvVarRows(next);
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    if (!form.checkValidity()) { form.reportValidity(); return; }

    const data = new FormData(form);

    // Build env_vars from rows
    const env_vars: Record<string, string> = {};
    for (const { k, v } of envVarRows) {
      if (k.trim()) env_vars[k.trim()] = v;
    }

    const payload = {
      org_key: orgKey ?? (data.get('org_key') as string),
      env_key: (data.get('env_key') as string).trim().toLowerCase(),
      region_id: data.get('region_id') as string,
      image: (data.get('image') as string).trim(),
      replicas: parseInt(data.get('replicas') as string, 10),
      memory_req: (data.get('memory_req') as string).trim(),
      memory_limit: (data.get('memory_limit') as string).trim(),
      cpu_req: (data.get('cpu_req') as string).trim(),
      cpu_limit: (data.get('cpu_limit') as string).trim(),
      env_vars,
    };

    setSubmitting(true);
    clearToast();

    try {
      const res = await fetch('/api/envs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const created: CustomerEnv = await res.json();
        form.reset();
        setEnvVarRows([]);
        onSuccess?.(created);
        onClose();
      } else {
        const body = await res.json().catch(() => ({}));
        if (res.status === 409) {
          showToast(body.error ?? 'That environment key already exists for this organization.', 'error');
        } else if (res.status === 422) {
          const details: string[] = Array.isArray(body.details) ? body.details : [];
          showToast(details.length > 0 ? details.join(' • ') : (body.error ?? 'Validation failed.'), 'error');
        } else {
          showToast(body.error ?? 'Failed to create environment. Please try again.', 'error');
        }
      }
    } catch {
      showToast('Network error. Please check your connection and try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
    <dialog ref={dialogRef} className="modal" aria-labelledby="create-env-modal-title">
      <div className="modal-backdrop" onClick={handleClose} />
      <div className="modal-box w-full max-w-2xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h3 id="create-env-modal-title" className="text-lg font-bold">
            Create Environment
            {orgKey && (
              <span className="ml-2 badge badge-outline badge-sm font-mono font-normal align-middle">
                {orgKey}
              </span>
            )}
          </h3>
          <button type="button" className="btn btn-sm btn-circle btn-ghost" onClick={handleClose} disabled={submitting} aria-label="Close modal">
            ✕
          </button>
        </div>

        <form ref={formRef} onSubmit={handleSubmit} noValidate>

          {/* ── Organization ── */}
          {orgKey ? (
            <fieldset className="fieldset mb-2">
              <legend className="fieldset-legend">Organization</legend>
              <input type="text" className="input w-full font-mono" value={orgKey} readOnly aria-label="Organization (pre-selected)" />
              <p className="fieldset-label">Inherited from the current org filter.</p>
            </fieldset>
          ) : (
            <fieldset className="fieldset mb-2">
              <legend className="fieldset-legend">
                Organization <span className="text-error" aria-hidden="true">*</span>
              </legend>
              {orgsLoading ? (
                <div className="flex items-center gap-2 h-12">
                  <span className="loading loading-spinner loading-sm" aria-hidden="true" />
                  <span className="text-sm text-base-content/60">Loading organizations…</span>
                </div>
              ) : orgsError ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-error">{orgsError}</span>
                  <button type="button" className="btn btn-xs btn-ghost" onClick={fetchOrgs}>Retry</button>
                </div>
              ) : (
                <select name="org_key" required className="select w-full" defaultValue="">
                  <option value="" disabled>— select an organization —</option>
                  {orgs.map((org) => (
                    <option key={org.org_key} value={org.org_key}>
                      {org.org_long_name} ({org.org_key})
                    </option>
                  ))}
                </select>
              )}
            </fieldset>
          )}

          {/* ── Environment Key ── */}
          <fieldset className="fieldset mb-2">
            <legend className="fieldset-legend">
              Environment Key <span className="text-error" aria-hidden="true">*</span>
            </legend>
            <input
              name="env_key"
              type="text"
              className="input validator w-full font-mono"
              placeholder="prod"
              required
              pattern="[a-zA-Z0-9][a-zA-Z0-9\-]*"
              minLength={2}
              maxLength={63}
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
            />
            <p className="validator-hint">
              2–63 characters — letters, numbers, and hyphens only.
              <br />Used in the Kubernetes namespace.
            </p>
          </fieldset>

          {/* ── Region ── */}
          <fieldset className="fieldset mb-2">
            <legend className="fieldset-legend">
              Region <span className="text-error" aria-hidden="true">*</span>
            </legend>
            <select name="region_id" required className="select w-full" defaultValue={DEFAULTS.region_id} disabled={submitting}>
              {REGION_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
            <p className="fieldset-label">Deployment region for this environment.</p>
          </fieldset>

          {/* ── Container Image ── */}
          <fieldset className="fieldset mb-2">
            <legend className="fieldset-legend">
              Container Image <span className="text-error" aria-hidden="true">*</span>
            </legend>
            <input
              name="image"
              type="text"
              className="input validator w-full font-mono"
              defaultValue={DEFAULTS.image}
              placeholder="mirror.gcr.io/dotcms/dotcms:LTS-24.10"
              required
              minLength={3}
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
            />
            <p className="validator-hint">Fully-qualified dotCMS container image reference.</p>
          </fieldset>

          {/* ── Replicas ── */}
          <fieldset className="fieldset mb-4">
            <legend className="fieldset-legend">
              Replicas <span className="text-error" aria-hidden="true">*</span>
            </legend>
            <input
              name="replicas"
              type="number"
              className="input validator w-full"
              placeholder="1"
              required
              min={1}
              step={1}
              defaultValue={DEFAULTS.replicas}
              disabled={submitting}
            />
            <p className="validator-hint">Number of dotCMS pod replicas (≥ 1).</p>
          </fieldset>

          {/* ── Resource Sizing ── */}
          <fieldset className="fieldset border border-base-300 rounded-box p-4 mb-4">
            <legend className="fieldset-legend">Resource Sizing <span className="text-base-content/50 font-normal text-xs ml-1">Optional</span></legend>
            <div className="grid grid-cols-2 gap-3">
              <fieldset className="fieldset">
                <legend className="fieldset-legend text-xs font-normal">Memory Request</legend>
                <input name="memory_req" type="text" className="input input-sm w-full font-mono" defaultValue={DEFAULTS.memory_req} placeholder="4Gi" disabled={submitting} />
              </fieldset>
              <fieldset className="fieldset">
                <legend className="fieldset-legend text-xs font-normal">Memory Limit</legend>
                <input name="memory_limit" type="text" className="input input-sm w-full font-mono" defaultValue={DEFAULTS.memory_limit} placeholder="5Gi" disabled={submitting} />
              </fieldset>
              <fieldset className="fieldset">
                <legend className="fieldset-legend text-xs font-normal">CPU Request</legend>
                <input name="cpu_req" type="text" className="input input-sm w-full font-mono" defaultValue={DEFAULTS.cpu_req} placeholder="500m" disabled={submitting} />
              </fieldset>
              <fieldset className="fieldset">
                <legend className="fieldset-legend text-xs font-normal">CPU Limit</legend>
                <input name="cpu_limit" type="text" className="input input-sm w-full font-mono" defaultValue={DEFAULTS.cpu_limit} placeholder="2000m" disabled={submitting} />
              </fieldset>
            </div>
          </fieldset>

          {/* ── Environment Variables ── */}
          <fieldset className="fieldset border border-base-300 rounded-box p-4 mb-6">
            <legend className="fieldset-legend">Environment Variables <span className="text-base-content/50 font-normal text-xs ml-1">Optional</span></legend>
            <p className="fieldset-label mb-3">Additional variables injected into the dotCMS container.</p>

            {envVarRows.length > 0 && (
              <div className="space-y-2 mb-3">
                <div className="grid grid-cols-[1fr_1fr_auto] gap-2 text-xs font-medium text-base-content/60 px-1">
                  <span>Name</span><span>Value</span><span />
                </div>
                {envVarRows.map((row, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                    <input
                      type="text"
                      value={row.k}
                      onChange={(e) => commitRows(envVarRows.map((r, idx) => idx === i ? { ...r, k: e.target.value } : r))}
                      placeholder="VAR_NAME"
                      spellCheck={false}
                      autoComplete="off"
                      className="input input-sm w-full font-mono"
                      aria-label={`Variable ${i + 1} name`}
                    />
                    <input
                      type="text"
                      value={row.v}
                      onChange={(e) => commitRows(envVarRows.map((r, idx) => idx === i ? { ...r, v: e.target.value } : r))}
                      placeholder="value"
                      spellCheck={false}
                      autoComplete="off"
                      className="input input-sm w-full font-mono"
                      aria-label={`Variable ${i + 1} value`}
                    />
                    <button type="button" onClick={() => commitRows(envVarRows.filter((_, idx) => idx !== i))} aria-label={`Remove ${row.k || `row ${i + 1}`}`} className="btn btn-square btn-ghost btn-sm text-base-content/40 hover:text-error">✕</button>
                  </div>
                ))}
              </div>
            )}

            <button type="button" onClick={() => commitRows([...envVarRows, { k: '', v: '' }])} className="btn btn-ghost btn-xs gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3 h-3" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Add variable
            </button>
          </fieldset>

          <div className="modal-action mt-0">
            <button type="button" className="btn btn-ghost" onClick={handleClose} disabled={submitting}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={submitting || (!orgKey && (orgsLoading || !!orgsError))}>
              {submitting
                ? <><span className="loading loading-spinner loading-sm" aria-hidden="true" />Creating…</>
                : 'Create Environment'}
            </button>
          </div>
        </form>
      </div>
    </dialog>
    {toast && <Toast message={toast.message} type={toast.type} onClose={clearToast} />}
    </>
  );
}
