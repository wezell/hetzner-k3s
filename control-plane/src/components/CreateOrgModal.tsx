'use client';

import { useRef, useState, useEffect } from 'react';
import type { CustomerOrg } from '@/db/types';
import { useToast } from '@/hooks/useToast';
import Toast from '@/components/Toast';

export interface CreateOrgModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: (org: CustomerOrg) => void;
}

export default function CreateOrgModal({ open, onClose, onSuccess }: CreateOrgModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const [submitting, setSubmitting] = useState(false);
  const { toast, showToast, clearToast } = useToast();

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

  function handleClose() {
    if (submitting) return;
    formRef.current?.reset();
    clearToast();
    onClose();
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    if (!form.checkValidity()) { form.reportValidity(); return; }

    const data = new FormData(form);
    const org_key = (data.get('org_key') as string).trim().toLowerCase();
    const org_long_name = (data.get('org_long_name') as string).trim();
    const org_email_domain = (data.get('org_email_domain') as string).trim().toLowerCase();

    setSubmitting(true);

    try {
      const res = await fetch('/api/orgs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_key, org_long_name, org_email_domain }),
      });

      if (res.ok) {
        const created: CustomerOrg = await res.json();
        form.reset();
        onSuccess?.(created);
        onClose();
      } else {
        const body = await res.json().catch(() => ({}));
        if (res.status === 409) {
          showToast('An organization with that key already exists.', 'error');
        } else if (res.status === 422) {
          const details: string[] = Array.isArray(body.details) ? body.details : [];
          showToast(details.length > 0 ? details.join(' • ') : (body.error ?? 'Validation failed.'), 'error');
        } else {
          showToast(body.error ?? 'Failed to create organization. Please try again.', 'error');
        }
      }
    } catch {
      showToast('Network error. Please check your connection and try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
    <dialog ref={dialogRef} className="modal" aria-labelledby="create-org-modal-title">
      <div className="modal-backdrop" onClick={handleClose} />
      <div className="modal-box w-full max-w-lg overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h3 id="create-org-modal-title" className="text-lg font-bold">
            Create Organization
          </h3>
          <button
            type="button"
            className="btn btn-sm btn-circle btn-ghost"
            onClick={handleClose}
            aria-label="Close modal"
            disabled={submitting}
          >✕</button>
        </div>

        <form ref={formRef} onSubmit={handleSubmit} noValidate>

          {/* Organization Name */}
          <fieldset className="fieldset mb-2">
            <legend className="fieldset-legend">
              Organization Name <span className="text-error" aria-hidden="true">*</span>
            </legend>
            <input
              name="org_long_name"
              type="text"
              className="input validator w-full"
              placeholder="Acme Corporation"
              required
              minLength={2}
              maxLength={255}
              autoComplete="off"
              disabled={submitting}
            />
            <p className="validator-hint">Required. 2–255 characters.</p>
          </fieldset>

          {/* Organization Key */}
          <fieldset className="fieldset mb-2">
            <legend className="fieldset-legend">
              Organization Key <span className="text-error" aria-hidden="true">*</span>
            </legend>
            <input
              name="org_key"
              type="text"
              className="input validator w-full font-mono"
              placeholder="acme-corp"
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
              <br />Used as the Kubernetes namespace prefix.
            </p>
          </fieldset>

          {/* Email Domain (optional) */}
          <fieldset className="fieldset mb-6">
            <legend className="fieldset-legend">
              Email Domain
              <span className="text-base-content/50 font-normal text-xs ml-1">Optional</span>
            </legend>
            <input
              name="org_email_domain"
              type="text"
              className="input w-full"
              placeholder="acme.com"
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
            />
            <p className="fieldset-label">Domain used to match users to this organization.</p>
          </fieldset>

          <div className="modal-action mt-0">
            <button type="button" className="btn btn-ghost" onClick={handleClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting
                ? <><span className="loading loading-spinner loading-sm" aria-hidden="true" />Creating…</>
                : 'Create Organization'}
            </button>
          </div>
        </form>
      </div>
    </dialog>
    {toast && <Toast message={toast.message} type={toast.type} onClose={clearToast} />}
    </>
  );
}
