/**
 * settingsForm.ts
 *
 * Pure utility functions for the environment detail page settings form.
 * Extracted so validation and form-state logic can be tested without jsdom.
 *
 * The component (app/envs/[org]/[env]/page.tsx) imports and delegates to these
 * helpers so all branching logic lives here — not inlined in the component.
 */

import type { CustomerEnv } from '@/db/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mirrors every editable field on the settings form. */
export interface SettingsFormState {
  image: string;
  replicas: string; // kept as string for the <input>; parsed to number on save
  memory_req: string;
  memory_limit: string;
  cpu_req: string;
  cpu_limit: string;
  env_vars_raw: string; // JSON textarea — must be a valid JSON object or empty
  /** date string (YYYY-MM-DD) or '' to clear */
  stop_date?: string;
  /** date string (YYYY-MM-DD) or '' to clear */
  dcomm_date?: string;
}

/** Fully-validated, typed payload ready to send in the PATCH request body. */
export interface ValidatedSettings {
  image: string;
  replicas: number;
  memory_req: string;
  memory_limit: string;
  cpu_req: string;
  cpu_limit: string;
  env_vars: Record<string, string>;
  /** ISO string or null to clear */
  stop_date?: string | null;
  /** ISO string or null to clear */
  dcomm_date?: string | null;
}

/** Discriminated union returned by validateSettingsForm. */
export type ValidationResult =
  | { valid: true; data: ValidatedSettings }
  | { valid: false; error: string };

// ---------------------------------------------------------------------------
// envToFormState — map server data → editable form state
// ---------------------------------------------------------------------------

/**
 * Converts a CustomerEnv record from the server into the string-typed form
 * state that the settings form inputs are bound to.
 *
 * - `replicas` is stored as a string so the <input type="number"> can be a
 *   controlled component without coercing "1" → 1 on every keystroke.
 * - `env_vars` is pretty-printed as a JSON string for the textarea; an empty
 *   object becomes an empty string (cleaner UX than "{}").
 */
/** Convert an ISO timestamp to a date input value (YYYY-MM-DD) */
function isoToDate(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  } catch {
    return '';
  }
}

export function envToFormState(env: CustomerEnv): SettingsFormState {
  // env_vars may arrive as a string if postgres.js doesn't auto-parse JSONB
  const envVars: Record<string, string> =
    typeof env.env_vars === 'string'
      ? (() => { try { return JSON.parse(env.env_vars as unknown as string); } catch { return {}; } })()
      : (env.env_vars ?? {});

  return {
    image: env.image ?? '',
    replicas: String(env.replicas ?? '1'),
    memory_req: env.memory_req ?? '',
    memory_limit: env.memory_limit ?? '',
    cpu_req: env.cpu_req ?? '',
    cpu_limit: env.cpu_limit ?? '',
    env_vars_raw:
      envVars && Object.keys(envVars).length > 0
        ? JSON.stringify(envVars, null, 2)
        : '',
    stop_date: isoToDate(env.stop_date),
    dcomm_date: isoToDate(env.dcomm_date),
  };
}

// ---------------------------------------------------------------------------
// validateSettingsForm — validate before PATCH
// ---------------------------------------------------------------------------

/**
 * Validates the settings form state before sending the PATCH request.
 *
 * Validation rules:
 * 1. `replicas` — must be a non-negative integer (NaN and negatives rejected).
 * 2. `env_vars_raw` — if non-empty after trimming, must be valid JSON *and*
 *    must deserialize to a plain object (not an array or primitive).
 *    An empty string is accepted and treated as "clear all env vars".
 *
 * Returns a discriminated union:
 * - `{ valid: true, data: ValidatedSettings }` on success.
 * - `{ valid: false, error: string }` with a human-readable message on failure.
 */
export function validateSettingsForm(form: SettingsFormState): ValidationResult {
  // ── env_vars_raw ──────────────────────────────────────────────────────────
  let parsedEnvVars: Record<string, string> = {};

  if (form.env_vars_raw.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(form.env_vars_raw);
    } catch {
      return { valid: false, error: 'Environment Variables is not valid JSON' };
    }

    if (
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      parsed === null
    ) {
      return {
        valid: false,
        error: 'Environment Variables must be a JSON object, e.g. {"KEY": "value"}',
      };
    }

    parsedEnvVars = parsed as Record<string, string>;
  }

  // ── replicas ──────────────────────────────────────────────────────────────
  const replicasNum = parseInt(form.replicas, 10);
  if (isNaN(replicasNum) || replicasNum < 0) {
    return { valid: false, error: 'Replicas must be a non-negative integer' };
  }

  // Convert date strings (YYYY-MM-DD) to ISO or null for the API
  const toISO = (v: string | undefined): string | null | undefined => {
    if (v === undefined) return undefined;
    return v.trim() ? v.trim() : null;
  };

  return {
    valid: true,
    data: {
      image: form.image,
      replicas: replicasNum,
      memory_req: form.memory_req,
      memory_limit: form.memory_limit,
      cpu_req: form.cpu_req,
      cpu_limit: form.cpu_limit,
      env_vars: parsedEnvVars,
      stop_date: toISO(form.stop_date),
      dcomm_date: toISO(form.dcomm_date),
    },
  };
}

// ---------------------------------------------------------------------------
// isSettingsDirty — detect unsaved changes
// ---------------------------------------------------------------------------

/**
 * Returns true when the current form state differs from what the server last
 * returned for this environment.
 *
 * Implemented by comparing JSON-serialised snapshots so that field order and
 * whitespace normalisation do not produce false positives.
 */
export function isSettingsDirty(
  form: SettingsFormState,
  env: CustomerEnv
): boolean {
  return JSON.stringify(form) !== JSON.stringify(envToFormState(env));
}
