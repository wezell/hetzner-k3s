'use client';

import { useState, useId, useEffect, useCallback } from 'react';
import EnvVarsEditor from '@/components/EnvVarsEditor';
import type { CustomerEnv, CustomerOrg } from '@/db/types';

// Kubernetes DNS label: lowercase alphanumeric and hyphens, 1-63 chars
const K8S_DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnvFormValues {
  org_key: string;
  env_key: string;
  region_id: string;
  image: string;
  replicas: string;
  memory_req: string;
  memory_limit: string;
  cpu_req: string;
  cpu_limit: string;
  env_vars: Record<string, string>;
}

export interface EnvFormErrors {
  org_key?: string;
  env_key?: string;
  region_id?: string;
  image?: string;
  replicas?: string;
  memory_req?: string;
  memory_limit?: string;
  cpu_req?: string;
  cpu_limit?: string;
  form?: string;
}

// ---------------------------------------------------------------------------
// Region options
// ---------------------------------------------------------------------------
export interface RegionOption {
  value: string;
  label: string;
}

export const REGION_OPTIONS: RegionOption[] = [
  { value: 'ash', label: 'Ashburn, VA (ash)' }
  /*,
  { value: 'hil', label: 'US Hillsboro, OR  (hil)' }
  { value: 'fsn1', label: 'Falkenstein, DE (fsn1)' },
  { value: 'nbg1', label: 'Nuremberg, DE (nbg1)' },
  { value: 'hel1', label: 'Helsinki, FI (hel1)' },
   */
];

export const DEFAULTS: EnvFormValues = {
  org_key: '',
  env_key: '',
  region_id: 'ash',
  image: 'mirror.gcr.io/dotcms/dotcms:java-25',
  replicas: '1',
  memory_req: '4Gi',
  memory_limit: '4Gi',
  cpu_req: '1',
  cpu_limit: '4',
  env_vars: {
    "CUSTOM_STARTER_URL":
    "https://repo.dotcms.com/artifactory/libs-release-local/com/dotcms/starter/min_20260407/starter-min_20260407.zip",
    "DOT_INITIAL_ADMIN_PASSWORD":"changeMe",
    "JAVA_OPTS_MEMORY":"-XX:MaxRAMPercentage=67"
  },
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateEnvForm(values: EnvFormValues): EnvFormErrors {
  const errors: EnvFormErrors = {};

  if (!values.org_key) {
    errors.org_key = 'Organization is required.';
  }

  const envKey = values.env_key.trim();
  if (!envKey) {
    errors.env_key = 'Environment key is required.';
  } else if (!K8S_DNS_LABEL_RE.test(envKey)) {
    errors.env_key =
      'Environment key must contain only lowercase letters, numbers, and hyphens, and must start and end with a letter or number.';
  } else if (envKey.length > 63) {
    errors.env_key = 'Environment key must be 63 characters or fewer.';
  }

  if (!values.image.trim()) {
    errors.image = 'Container image is required.';
  }

  const replicas = Number(values.replicas);
  if (!values.replicas || !Number.isInteger(replicas) || replicas < 1) {
    errors.replicas = 'Replicas must be a positive integer.';
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface EnvFormProps {
  /** Called with the created CustomerEnv record after a successful API creation. */
  onSuccess?: (env: CustomerEnv) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function EnvForm({ onSuccess }: EnvFormProps) {
  const formId = useId();

  const [values, setValues] = useState<EnvFormValues>(DEFAULTS);
  const [touched, setTouched] = useState<Record<keyof EnvFormValues, boolean>>({
    org_key: false,
    env_key: false,
    region_id: false,
    image: false,
    replicas: false,
    memory_req: false,
    memory_limit: false,
    cpu_req: false,
    cpu_limit: false,
    env_vars: false,
  });

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [createdEnv, setCreatedEnv] = useState<CustomerEnv | null>(null);

  // Org list for the dropdown
  const [orgs, setOrgs] = useState<CustomerOrg[]>([]);
  const [orgsLoading, setOrgsLoading] = useState(true);
  const [orgsError, setOrgsError] = useState<string | null>(null);

  const fetchOrgs = useCallback(() => {
    setOrgsLoading(true);
    setOrgsError(null);
    fetch('/api/orgs')
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((data: CustomerOrg[]) => setOrgs(data))
      .catch(() => setOrgsError('Failed to load organizations.'))
      .finally(() => setOrgsLoading(false));
  }, []);

  useEffect(() => {
    fetchOrgs();
  }, [fetchOrgs]);

  const errors = validateEnvForm(values);
  const isValid = Object.keys(errors).length === 0;

  function handleChange(
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) {
    const { name, value } = e.target;
    setValues((prev) => ({ ...prev, [name]: value }));
    setFormError(null);
    setCreatedEnv(null);
  }

  function handleEnvVarsChange(vars: Record<string, string>) {
    setValues((prev) => ({ ...prev, env_vars: vars }));
    setFormError(null);
    setCreatedEnv(null);
  }

  function handleBlur(
    e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>
  ) {
    const { name } = e.target;
    setTouched((prev) => ({ ...prev, [name]: true }));
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    // Mark all fields touched
    const allTouched = Object.fromEntries(
      Object.keys(DEFAULTS).map((k) => [k, true])
    ) as Record<keyof EnvFormValues, boolean>;
    setTouched(allTouched);

    if (!isValid) return;

    setSubmitting(true);
    setFormError(null);

    try {
      const res = await fetch('/api/envs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_key: values.org_key,
          env_key: values.env_key.trim().toLowerCase(),
          region_id: values.region_id,
          image: values.image.trim(),
          replicas: parseInt(values.replicas, 10),
          memory_req: values.memory_req.trim(),
          memory_limit: values.memory_limit.trim(),
          cpu_req: values.cpu_req.trim(),
          cpu_limit: values.cpu_limit.trim(),
          env_vars: values.env_vars,
        }),
      });

      if (res.ok) {
        const created: CustomerEnv = await res.json();
        setCreatedEnv(created);
        setValues(DEFAULTS);
        setTouched(
          Object.fromEntries(
            Object.keys(DEFAULTS).map((k) => [k, false])
          ) as Record<keyof EnvFormValues, boolean>
        );
        onSuccess?.(created);
      } else {
        const body = await res.json().catch(() => ({}));
        if (res.status === 409) {
          setFormError(
            body.error ?? 'That environment key already exists for this organization.'
          );
        } else if (res.status === 422) {
          const details: string[] = Array.isArray(body.details) ? body.details : [];
          setFormError(details.length > 0 ? details.join(' • ') : (body.error ?? 'Validation failed.'));
        } else {
          setFormError(body.error ?? 'Failed to create environment. Please try again.');
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
      aria-label="Create environment"
    >
      {/* org_key — select from existing orgs */}
      <div className="flex flex-col gap-1">
        <label
          htmlFor={`${formId}-org-key`}
          className="text-sm font-medium text-zinc-900 dark:text-zinc-100"
        >
          Organization
          <span aria-hidden="true" className="ml-1 text-red-500">*</span>
        </label>
        <p id={`${formId}-org-key-hint`} className="text-xs text-zinc-500 dark:text-zinc-400">
          The organization this environment belongs to.
        </p>

        {orgsLoading ? (
          <div className="flex h-9 items-center">
            <span className="text-xs text-zinc-500 dark:text-zinc-400">Loading organizations…</span>
          </div>
        ) : orgsError ? (
          <div className="flex h-9 items-center gap-2">
            <span className="text-xs text-red-600 dark:text-red-400">{orgsError}</span>
            <button
              type="button"
              onClick={fetchOrgs}
              className="text-xs underline text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
            >
              Retry
            </button>
          </div>
        ) : (
          <select
            id={`${formId}-org-key`}
            name="org_key"
            value={values.org_key}
            onChange={handleChange}
            onBlur={handleBlur}
            required
            aria-describedby={`${formId}-org-key-hint`}
            aria-invalid={touched.org_key && errors.org_key ? 'true' : undefined}
            className={[
              'h-9 w-full rounded-md border px-3 text-sm outline-none transition-colors',
              'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100',
              'focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100',
              touched.org_key && errors.org_key
                ? 'border-red-500 focus:ring-red-500'
                : 'border-zinc-300 dark:border-zinc-700',
            ].join(' ')}
          >
            <option value="">— select an organization —</option>
            {orgs.map((org) => (
              <option key={org.org_key} value={org.org_key}>
                {org.org_long_name} ({org.org_key})
              </option>
            ))}
          </select>
        )}

        {touched.org_key && errors.org_key && (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {errors.org_key}
          </p>
        )}
      </div>

      {/* env_key */}
      <Field
        id={`${formId}-env-key`}
        name="env_key"
        label="Environment key"
        hint="Short slug for this environment (e.g. prod, staging). Used in the Kubernetes namespace."
        value={values.env_key}
        error={touched.env_key ? errors.env_key : undefined}
        onChange={handleChange}
        onBlur={handleBlur}
        autoComplete="off"
        spellCheck={false}
        placeholder="prod"
        maxLength={63}
        required
      />

      {/* region_id — select from known regions */}
      <div className="flex flex-col gap-1">
        <label
          htmlFor={`${formId}-region-id`}
          className="text-sm font-medium text-zinc-900 dark:text-zinc-100"
        >
          Region
          <span aria-hidden="true" className="ml-1 text-red-500">*</span>
        </label>
        <p id={`${formId}-region-id-hint`} className="text-xs text-zinc-500 dark:text-zinc-400">
          Deployment region for this environment (reserved for future multi-region routing).
        </p>
        <select
          id={`${formId}-region-id`}
          name="region_id"
          value={values.region_id}
          onChange={handleChange}
          onBlur={handleBlur}
          required
          aria-describedby={`${formId}-region-id-hint`}
          aria-invalid={touched.region_id && errors.region_id ? 'true' : undefined}
          className={[
            'h-9 w-full rounded-md border px-3 text-sm outline-none transition-colors',
            'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100',
            'focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100',
            touched.region_id && errors.region_id
              ? 'border-red-500 focus:ring-red-500'
              : 'border-zinc-300 dark:border-zinc-700',
          ].join(' ')}
        >
          {REGION_OPTIONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        {touched.region_id && errors.region_id && (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {errors.region_id}
          </p>
        )}
      </div>

      {/* image */}
      <Field
        id={`${formId}-image`}
        name="image"
        label="Container image"
        hint="Fully-qualified dotCMS container image reference, e.g. mirror.gcr.io/dotcms/dotcms:latest."
        value={values.image}
        error={touched.image ? errors.image : undefined}
        onChange={handleChange}
        onBlur={handleBlur}
        autoComplete="off"
        spellCheck={false}
        placeholder="mirror.gcr.io/dotcms/dotcms:latest"
        required
      />

      {/* replicas */}
      <Field
        id={`${formId}-replicas`}
        name="replicas"
        label="Replicas"
        hint="Number of dotCMS pod replicas (≥ 1)."
        value={values.replicas}
        error={touched.replicas ? errors.replicas : undefined}
        onChange={handleChange}
        onBlur={handleBlur}
        type="number"
        min={1}
        step={1}
        placeholder="1"
        required
      />

      {/* Resource sizing — collapsible group */}
      <fieldset className="rounded-md border border-zinc-200 dark:border-zinc-700 p-4 space-y-4">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Resource sizing (optional)
        </legend>

        <div className="grid grid-cols-2 gap-4">
          <Field
            id={`${formId}-memory-req`}
            name="memory_req"
            label="Memory request"
            hint="Kubernetes memory request for dotCMS pods, e.g. 4Gi."
            value={values.memory_req}
            error={touched.memory_req ? errors.memory_req : undefined}
            onChange={handleChange}
            onBlur={handleBlur}
            placeholder="4Gi"
          />
          <Field
            id={`${formId}-memory-limit`}
            name="memory_limit"
            label="Memory limit"
            hint="Kubernetes memory limit for dotCMS pods, e.g. 5Gi."
            value={values.memory_limit}
            error={touched.memory_limit ? errors.memory_limit : undefined}
            onChange={handleChange}
            onBlur={handleBlur}
            placeholder="5Gi"
          />
          <Field
            id={`${formId}-cpu-req`}
            name="cpu_req"
            label="CPU request"
            hint="Kubernetes CPU request in millicores, e.g. 500m."
            value={values.cpu_req}
            error={touched.cpu_req ? errors.cpu_req : undefined}
            onChange={handleChange}
            onBlur={handleBlur}
            placeholder="500m"
          />
          <Field
            id={`${formId}-cpu-limit`}
            name="cpu_limit"
            label="CPU limit"
            hint="Kubernetes CPU limit in millicores, e.g. 2000m."
            value={values.cpu_limit}
            error={touched.cpu_limit ? errors.cpu_limit : undefined}
            onChange={handleChange}
            onBlur={handleBlur}
            placeholder="2000m"
          />
        </div>
      </fieldset>

      {/* env_vars — key/value editor */}
      <EnvVarsEditor value={values.env_vars} onChange={handleEnvVarsChange} />

      {/* Form-level feedback */}
      {formError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {formError}
        </p>
      )}

      {createdEnv && (
        <div
          role="status"
          className="rounded-md border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-950"
        >
          <p className="mb-2 text-sm font-semibold text-green-800 dark:text-green-300">
            Environment created — queued for provisioning.
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="font-medium text-green-700 dark:text-green-400">Organization</dt>
            <dd className="font-mono text-green-900 dark:text-green-200">{createdEnv.org_key}</dd>
            <dt className="font-medium text-green-700 dark:text-green-400">Environment</dt>
            <dd className="font-mono text-green-900 dark:text-green-200">{createdEnv.env_key}</dd>
            <dt className="font-medium text-green-700 dark:text-green-400">Namespace</dt>
            <dd className="font-mono text-green-900 dark:text-green-200">
              {createdEnv.org_key}-{createdEnv.env_key}
            </dd>
            <dt className="font-medium text-green-700 dark:text-green-400">Image</dt>
            <dd className="font-mono text-green-900 dark:text-green-200 break-all">{createdEnv.image}</dd>
            <dt className="font-medium text-green-700 dark:text-green-400">Status</dt>
            <dd className="text-green-900 dark:text-green-200">{createdEnv.deploy_status}</dd>
            <dt className="font-medium text-green-700 dark:text-green-400">Created</dt>
            <dd className="text-green-900 dark:text-green-200">
              {new Date(createdEnv.created_date).toLocaleString()}
            </dd>
          </dl>
        </div>
      )}

      <button
        type="submit"
        disabled={submitting || orgsLoading || !!orgsError}
        className="inline-flex h-10 items-center justify-center rounded-md bg-zinc-900 px-6 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {submitting ? 'Creating…' : 'Create environment'}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Internal Field component
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
  type?: string;
  min?: number;
  step?: number;
}

function Field({
  id, name, label, hint, value, error, onChange, onBlur,
  placeholder, required, autoComplete, spellCheck, maxLength,
  type = 'text', min, step,
}: FieldProps) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const hasError = Boolean(error);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
        {label}
        {required && <span aria-hidden="true" className="ml-1 text-red-500">*</span>}
      </label>
      {hint && <p id={hintId} className="text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>}
      <input
        id={id} name={name} type={type} value={value}
        onChange={onChange} onBlur={onBlur} placeholder={placeholder}
        required={required} autoComplete={autoComplete} spellCheck={spellCheck}
        maxLength={maxLength} min={min} step={step}
        aria-describedby={[hint ? hintId : '', hasError ? errorId : ''].filter(Boolean).join(' ') || undefined}
        aria-invalid={hasError ? 'true' : undefined}
        className={[
          'h-9 w-full rounded-md border px-3 text-sm outline-none transition-colors',
          'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100',
          'placeholder:text-zinc-400 dark:placeholder:text-zinc-500',
          'focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100',
          hasError ? 'border-red-500 focus:ring-red-500' : 'border-zinc-300 dark:border-zinc-700',
        ].join(' ')}
      />
      {hasError && <p id={errorId} role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
