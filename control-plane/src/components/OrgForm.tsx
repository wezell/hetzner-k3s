'use client';

import { useState, useId } from 'react';
import type { CustomerOrg } from '@/db/types';

// Kubernetes DNS label: lowercase alphanumeric and hyphens, 1-63 chars,
// must start and end with alphanumeric. Mirrors the validation in /api/orgs.
const K8S_DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export interface OrgFormValues {
  org_key: string;
  org_long_name: string;
  org_email_domain: string;
}

export interface OrgFormErrors {
  org_key?: string;
  org_long_name?: string;
  org_email_domain?: string;
  form?: string;
}

export function validateOrgForm(values: OrgFormValues): OrgFormErrors {
  const errors: OrgFormErrors = {};

  // org_key: required, Kubernetes DNS label format
  const key = values.org_key.trim();
  if (!key) {
    errors.org_key = 'Organization key is required.';
  } else if (key.length > 63) {
    errors.org_key = 'Organization key must be 63 characters or fewer.';
  } else if (!K8S_DNS_LABEL_RE.test(key)) {
    errors.org_key =
      'Organization key must contain only lowercase letters, numbers, and hyphens, and must start and end with a letter or number.';
  }

  // org_long_name: required
  if (!values.org_long_name.trim()) {
    errors.org_long_name = 'Organization name is required.';
  }

  // org_email_domain: optional, but must be valid if provided
  const domain = values.org_email_domain.trim().toLowerCase();
  if (domain && (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(domain) || !domain.includes('.'))) {
    errors.org_email_domain = 'Enter a valid email domain (e.g. example.com).';
  }

  return errors;
}

export interface OrgFormProps {
  /** Called with the created CustomerOrg record after successful API creation. */
  onSuccess?: (org: CustomerOrg) => void;
}

export default function OrgForm({ onSuccess }: OrgFormProps) {
  const formId = useId();

  const [values, setValues] = useState<OrgFormValues>({
    org_key: '',
    org_long_name: '',
    org_email_domain: '',
  });

  // touched tracks which fields the user has interacted with so we only show
  // errors after the user has left a field (or attempted submit).
  const [touched, setTouched] = useState<Record<keyof OrgFormValues, boolean>>({
    org_key: false,
    org_long_name: false,
    org_email_domain: false,
  });

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [createdOrg, setCreatedOrg] = useState<CustomerOrg | null>(null);

  const errors = validateOrgForm(values);
  const isValid = Object.keys(errors).length === 0;

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const { name, value } = e.target;
    setValues((prev) => ({ ...prev, [name]: value }));
    // Clear top-level form error when the user edits anything
    setFormError(null);
    setCreatedOrg(null);
  }

  function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
    const { name } = e.target;
    setTouched((prev) => ({ ...prev, [name]: true }));
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    // Mark all fields as touched to surface any remaining errors
    setTouched({ org_key: true, org_long_name: true, org_email_domain: false });

    if (!isValid) return;

    setSubmitting(true);
    setFormError(null);

    try {
      const res = await fetch('/api/orgs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_key: values.org_key.trim().toLowerCase(),
          org_long_name: values.org_long_name.trim(),
          org_email_domain: values.org_email_domain.trim().toLowerCase(),
        }),
      });

      if (res.ok) {
        const created: CustomerOrg = await res.json();
        setCreatedOrg(created);
        setValues({ org_key: '', org_long_name: '', org_email_domain: '' });
        setTouched({ org_key: false, org_long_name: false, org_email_domain: false });
        onSuccess?.(created);
      } else {
        const body = await res.json().catch(() => ({}));
        if (res.status === 409) {
          setFormError('An organization with that key already exists.');
        } else if (res.status === 422) {
          const details: string[] = Array.isArray(body.details) ? body.details : [];
          setFormError(details.length > 0 ? details.join(' • ') : (body.error ?? 'Validation failed.'));
        } else {
          setFormError(body.error ?? 'Failed to create organization. Please try again.');
        }
      }
    } catch {
      setFormError('Network error. Please check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      id={formId}
      onSubmit={handleSubmit}
      noValidate
      className="space-y-5"
      aria-label="Create organization"
    >
      {/* org_key */}
      <Field
        id={`${formId}-org-key`}
        name="org_key"
        label="Organization key"
        hint="Lowercase letters, numbers, and hyphens only (max 63 chars). Used as the Kubernetes namespace prefix."
        value={values.org_key}
        error={touched.org_key ? errors.org_key : undefined}
        onChange={handleChange}
        onBlur={handleBlur}
        autoComplete="off"
        spellCheck={false}
        placeholder="acme-corp"
        maxLength={63}
        required
      />  

      {/* org_long_name */}
      <Field
        id={`${formId}-org-long-name`}
        name="org_long_name"
        label="Organization name"
        hint="Full display name for the organization."
        value={values.org_long_name}
        error={touched.org_long_name ? errors.org_long_name : undefined}
        onChange={handleChange}
        onBlur={handleBlur}
        placeholder="Acme Corporation"
        required
      />

      {/* org_email_domain */}
      <Field
        id={`${formId}-org-email-domain`}
        name="org_email_domain"
        label="Email domain"
        hint="Optional. Domain used to match user accounts to this organization (e.g. acme.com)."
        value={values.org_email_domain}
        error={touched.org_email_domain ? errors.org_email_domain : undefined}
        onChange={handleChange}
        onBlur={handleBlur}
        autoComplete="off"
        spellCheck={false}
        placeholder="acme.com"
      />

      {/* Form-level feedback */}
      {formError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {formError}
        </p>
      )}
      {createdOrg && (
        <div
          role="status"
          className="rounded-md border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-950"
        >
          <p className="mb-2 text-sm font-semibold text-green-800 dark:text-green-300">
            Organization created successfully.
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="font-medium text-green-700 dark:text-green-400">Key</dt>
            <dd className="font-mono text-green-900 dark:text-green-200">{createdOrg.org_key}</dd>
            <dt className="font-medium text-green-700 dark:text-green-400">Name</dt>
            <dd className="text-green-900 dark:text-green-200">{createdOrg.org_long_name}</dd>
            <dt className="font-medium text-green-700 dark:text-green-400">Email domain</dt>
            <dd className="font-mono text-green-900 dark:text-green-200">{createdOrg.org_email_domain}</dd>
            <dt className="font-medium text-green-700 dark:text-green-400">Created</dt>
            <dd className="text-green-900 dark:text-green-200">
              {new Date(createdOrg.created_date).toLocaleString()}
            </dd>
          </dl>
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="inline-flex h-10 items-center justify-center rounded-md bg-zinc-900 px-6 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {submitting ? 'Creating…' : 'Create organization'}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Internal Field component — keeps the form JSX clean
// ---------------------------------------------------------------------------

interface FieldProps {
  id: string;
  name: string;
  label: string;
  hint?: string;
  value: string;
  error?: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onBlur: (e: React.FocusEvent<HTMLInputElement>) => void;
  placeholder?: string;
  required?: boolean;
  autoComplete?: string;
  spellCheck?: boolean;
  maxLength?: number;
}

function Field({
  id,
  name,
  label,
  hint,
  value,
  error,
  onChange,
  onBlur,
  placeholder,
  required,
  autoComplete,
  spellCheck,
  maxLength,
}: FieldProps) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const hasError = Boolean(error);

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
        {label}
        {required && (
          <span aria-hidden="true" className="ml-1 text-red-500">
            *
          </span>
        )}
      </label>

      {hint && (
        <p id={hintId} className="text-xs text-zinc-500 dark:text-zinc-400">
          {hint}
        </p>
      )}

      <input
        id={id}
        name={name}
        type="text"
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        placeholder={placeholder}
        required={required}
        autoComplete={autoComplete}
        spellCheck={spellCheck}
        maxLength={maxLength}
        aria-describedby={[hint ? hintId : '', hasError ? errorId : ''].filter(Boolean).join(' ') || undefined}
        aria-invalid={hasError ? 'true' : undefined}
        className={[
          'h-9 w-full rounded-md border px-3 text-sm outline-none transition-colors',
          'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100',
          'placeholder:text-zinc-400 dark:placeholder:text-zinc-500',
          'focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100',
          hasError
            ? 'border-red-500 focus:ring-red-500'
            : 'border-zinc-300 dark:border-zinc-700',
        ].join(' ')}
      />

      {hasError && (
        <p id={errorId} role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
