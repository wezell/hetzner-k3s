'use client';

import { useState, useEffect, useRef } from 'react';
import type { CustomerOrg } from '@/db/types';
import { useToast } from '@/hooks/useToast';
import Toast from '@/components/Toast';

interface OrgEditModalProps {
  org: CustomerOrg | null;
  open: boolean;
  onClose: () => void;
  onSuccess: (org: CustomerOrg) => void;
}

export default function OrgEditModal({ org, open, onClose, onSuccess }: OrgEditModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  const [longName, setLongName] = useState('');
  const [emailDomain, setEmailDomain] = useState('');
  const [orgActive, setOrgActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const { toast, showToast, clearToast } = useToast();

  useEffect(() => {
    if (org) {
      setLongName(org.org_long_name);
      setEmailDomain(org.org_email_domain ?? '');
      setOrgActive(org.org_active);
      clearToast();
    }
  }, [org, clearToast]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) { if (!dialog.open) dialog.showModal(); }
    else { if (dialog.open) dialog.close(); }
  }, [open]);

  async function handleSave() {
    if (!org) return;
    if (!longName.trim()) { showToast('Organization name is required.', 'error'); return; }

    setSaving(true);

    try {
      const res = await fetch(`/api/orgs/${encodeURIComponent(org.org_key)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_long_name: longName.trim(),
          org_email_domain: emailDomain.trim(),
          org_active: orgActive,
        }),
      });

      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        onSuccess(body as CustomerOrg);
      } else {
        const details = Array.isArray(body.details) ? body.details.join(' • ') : null;
        showToast(details ?? body.error ?? 'Failed to save changes.', 'error');
      }
    } catch {
      showToast('Network error. Please try again.', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
    <dialog ref={dialogRef} className="modal" onClose={onClose}>
      <div className="modal-box max-h-fit overflow-hidden">
        <h3 className="font-bold text-lg mb-5">
          Edit Organization
          {org && <span className="font-mono text-sm text-base-content/50 ml-2">({org.org_key})</span>}
        </h3>

        <div className="space-y-1">
          {/* Name */}
          <fieldset className="fieldset">
            <legend className="fieldset-legend">
              Organization name <span className="text-error">*</span>
            </legend>
            <input
              type="text"
              className="input w-full"
              value={longName}
              onChange={(e) => setLongName(e.target.value)}
              placeholder="Acme Corporation"
              disabled={saving}
            />
          </fieldset>

          {/* Email domain */}
          <fieldset className="fieldset">
            <legend className="fieldset-legend">
              Email domain
              <span className="text-base-content/50 font-normal text-xs ml-1">Optional</span>
            </legend>
            <input
              type="text"
              className="input w-full"
              value={emailDomain}
              onChange={(e) => setEmailDomain(e.target.value)}
              placeholder="acme.com"
              disabled={saving}
            />
          </fieldset>

          {/* Active toggle */}
          <fieldset className="fieldset">
            <legend className="fieldset-legend">Status</legend>
            <label className="fieldset-label cursor-pointer gap-3">
              <input
                type="checkbox"
                className="toggle toggle-primary"
                checked={orgActive}
                onChange={(e) => setOrgActive(e.target.checked)}
                disabled={saving}
              />
              <span>Active</span>
            </label>
          </fieldset>

        </div>

        <div className="modal-action mt-6">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving || !longName.trim()}
          >
            {saving ? <span className="loading loading-spinner loading-sm" /> : null}
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="submit">close</button>
      </form>
    </dialog>
    {toast && <Toast message={toast.message} type={toast.type} onClose={clearToast} />}
    </>
  );
}
