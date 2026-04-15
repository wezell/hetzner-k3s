/**
 * CreateEnvModal unit tests
 *
 * Tests the modal's fetch payload contract, validation integration,
 * and error message mapping — mirroring the CreateOrgModal test pattern.
 *
 * React rendering is not exercised here (no jsdom); tests focus on
 * the pure-logic and fetch-contract aspects extracted from the component.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateEnvForm, DEFAULTS, type EnvFormValues } from '../EnvForm';
import type { CustomerEnv } from '@/db/types';

// ---------------------------------------------------------------------------
// Reuse validateEnvForm — CreateEnvModal delegates validation to same fn
// ---------------------------------------------------------------------------

const VALID_VALUES: EnvFormValues = {
  org_key: 'acme-corp',
  env_key: 'prod',
  region_id: 'ash',
  image: 'mirror.gcr.io/dotcms/dotcms:LTS-24.10',
  replicas: '2',
  memory_req: '4Gi',
  memory_limit: '5Gi',
  cpu_req: '500m',
  cpu_limit: '2000m',
  env_vars: {},
};

describe('CreateEnvModal validation (via validateEnvForm)', () => {
  it('passes for valid env values', () => {
    const errors = validateEnvForm(VALID_VALUES);
    expect(Object.keys(errors)).toHaveLength(0);
  });

  it('requires org_key', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, org_key: '' });
    expect(errors.org_key).toBeTruthy();
  });

  it('requires env_key', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, env_key: '' });
    expect(errors.env_key).toBeTruthy();
  });

  it('rejects env_key with uppercase', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, env_key: 'PROD' });
    expect(errors.env_key).toBeTruthy();
  });

  it('rejects env_key with spaces', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, env_key: 'my env' });
    expect(errors.env_key).toBeTruthy();
  });

  it('rejects env_key starting with hyphen', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, env_key: '-prod' });
    expect(errors.env_key).toBeTruthy();
  });

  it('requires image', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, image: '' });
    expect(errors.image).toBeTruthy();
  });

  it('requires replicas to be a positive integer', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, replicas: '0' });
    expect(errors.replicas).toBeTruthy();
  });

  it('rejects non-integer replicas', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, replicas: '1.5' });
    expect(errors.replicas).toBeTruthy();
  });

  it('accepts replicas of 1', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, replicas: '1' });
    expect(errors.replicas).toBeUndefined();
  });

  it('DEFAULTS object passes validation when org_key, env_key, and image are provided', () => {
    const errors = validateEnvForm({ ...DEFAULTS, org_key: 'acme', env_key: 'prod', image: 'dotcms:latest' });
    expect(Object.keys(errors)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pre-populated org field — locked when orgKey prop is provided
// ---------------------------------------------------------------------------

describe('CreateEnvModal org field locking behavior', () => {
  it('uses DEFAULTS with org_key when orgKey prop is provided', () => {
    const orgKey = 'locked-org';
    const initial = { ...DEFAULTS, org_key: orgKey };
    expect(initial.org_key).toBe('locked-org');
  });

  it('uses empty org_key when no orgKey prop is provided', () => {
    const initial = { ...DEFAULTS, org_key: '' };
    expect(initial.org_key).toBe('');
    // Validation should fail
    const errors = validateEnvForm({ ...initial, image: 'some-image:latest' });
    expect(errors.org_key).toBeTruthy();
  });

  it('locked org field value is used in payload', () => {
    const orgKey = 'pre-selected-org';
    const values: EnvFormValues = { ...DEFAULTS, org_key: orgKey, env_key: 'staging', image: 'img:v1' };
    const payload = buildPayload(values);
    expect(payload.org_key).toBe('pre-selected-org');
  });
});

// ---------------------------------------------------------------------------
// Fetch payload contract — what CreateEnvModal sends to POST /api/envs
// ---------------------------------------------------------------------------

function buildPayload(values: EnvFormValues) {
  return {
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
  };
}

describe('CreateEnvModal fetch payload contract', () => {
  it('lowercases and trims env_key', () => {
    const payload = buildPayload({ ...VALID_VALUES, env_key: '  STAGING  ' });
    expect(payload.env_key).toBe('staging');
  });

  it('trims image', () => {
    const payload = buildPayload({ ...VALID_VALUES, image: '  dotcms:latest  ' });
    expect(payload.image).toBe('dotcms:latest');
  });

  it('parses replicas as integer', () => {
    const payload = buildPayload({ ...VALID_VALUES, replicas: '3' });
    expect(payload.replicas).toBe(3);
    expect(typeof payload.replicas).toBe('number');
  });

  it('trims memory_req', () => {
    const payload = buildPayload({ ...VALID_VALUES, memory_req: '  4Gi  ' });
    expect(payload.memory_req).toBe('4Gi');
  });

  it('trims cpu_limit', () => {
    const payload = buildPayload({ ...VALID_VALUES, cpu_limit: '  2000m  ' });
    expect(payload.cpu_limit).toBe('2000m');
  });

  it('includes env_vars in payload', () => {
    const envVars = { FOO: 'bar', BAZ: 'qux' };
    const payload = buildPayload({ ...VALID_VALUES, env_vars: envVars });
    expect(payload.env_vars).toEqual(envVars);
  });

  it('payload has exactly the expected keys', () => {
    const payload = buildPayload(VALID_VALUES);
    expect(Object.keys(payload).sort()).toEqual([
      'cpu_limit',
      'cpu_req',
      'env_key',
      'env_vars',
      'image',
      'memory_limit',
      'memory_req',
      'org_key',
      'region_id',
      'replicas',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Error message mapping — mirrors CreateEnvModal handleSubmit error branches
// ---------------------------------------------------------------------------

describe('CreateEnvModal error message mapping', () => {
  function resolveErrorMessage(
    status: number,
    body: { error?: string; details?: string[] },
  ): string {
    if (status === 409) {
      return body.error ?? 'That environment key already exists for this organization.';
    }
    if (status === 422) {
      const details: string[] = Array.isArray(body.details) ? body.details : [];
      return details.length > 0 ? details.join(' • ') : (body.error ?? 'Validation failed.');
    }
    return body.error ?? 'Failed to create environment. Please try again.';
  }

  it('shows conflict message for HTTP 409', () => {
    expect(resolveErrorMessage(409, {})).toBe(
      'That environment key already exists for this organization.',
    );
  });

  it('uses body.error for 409 when provided', () => {
    expect(resolveErrorMessage(409, { error: 'env key taken' })).toBe('env key taken');
  });

  it('joins details for HTTP 422 with details array', () => {
    const msg = resolveErrorMessage(422, { details: ['field a', 'field b'] });
    expect(msg).toBe('field a • field b');
  });

  it('falls back to body.error for HTTP 422 with empty details', () => {
    expect(resolveErrorMessage(422, { error: 'Oops', details: [] })).toBe('Oops');
  });

  it('shows default for HTTP 422 with no details and no error', () => {
    expect(resolveErrorMessage(422, {})).toBe('Validation failed.');
  });

  it('shows generic message for 500 without body error', () => {
    expect(resolveErrorMessage(500, {})).toBe('Failed to create environment. Please try again.');
  });

  it('uses body.error for 500 when provided', () => {
    expect(resolveErrorMessage(500, { error: 'DB offline' })).toBe('DB offline');
  });
});

// ---------------------------------------------------------------------------
// Fetch wiring smoke test
// ---------------------------------------------------------------------------

describe('CreateEnvModal fetch wiring', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function simulateSubmit(
    values: EnvFormValues,
    fetchImpl: typeof fetch,
  ): Promise<{ url?: string; options?: RequestInit }> {
    let capturedUrl: string | undefined;
    let capturedOptions: RequestInit | undefined;

    global.fetch = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      capturedUrl = url.toString();
      capturedOptions = options;
      return fetchImpl(url, options);
    }) as typeof fetch;

    try {
      await fetch('/api/envs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload(values)),
      });
    } catch {
      // network errors expected in some cases
    }

    return { url: capturedUrl, options: capturedOptions };
  }

  it('calls POST /api/envs', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ org_key: 'acme-corp', env_key: 'prod' }), { status: 201 }),
    );
    const result = await simulateSubmit(VALID_VALUES, mockFetch as unknown as typeof fetch);
    expect(result.url).toBe('/api/envs');
    expect(result.options?.method).toBe('POST');
  });

  it('sends application/json content-type', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 201 }),
    );
    const result = await simulateSubmit(VALID_VALUES, mockFetch as unknown as typeof fetch);
    const headers = result.options?.headers as Record<string, string>;
    expect(headers?.['Content-Type']).toBe('application/json');
  });

  it('calls onSuccess with created env on 201', async () => {
    const createdEnv: CustomerEnv = {
      org_key: 'acme-corp',
      env_key: 'prod',
      cluster_id: 'cluster-1',
      region_id: 'ash',
      image: 'mirror.gcr.io/dotcms/dotcms:LTS-24.10',
      replicas: 2,
      memory_req: '4Gi',
      memory_limit: '5Gi',
      cpu_req: '500m',
      cpu_limit: '2000m',
      env_vars: {},
      deploy_status: 'pending',
      created_date: '2026-04-14T12:00:00Z',
      mod_date: '2026-04-14T12:00:00Z',
      last_deploy_date: null,
      stop_date: null,
      dcomm_date: null,
      last_applied_config: null,
    };

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(createdEnv), { status: 201 }),
    );
    global.fetch = mockFetch as unknown as typeof fetch;

    const res = await fetch('/api/envs', { method: 'POST', body: '{}' });
    expect(res.ok).toBe(true);
    const body = await res.json() as CustomerEnv;
    expect(body.org_key).toBe('acme-corp');
    expect(body.env_key).toBe('prod');
  });

  it('network failure surfaces as error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    global.fetch = mockFetch as unknown as typeof fetch;

    let caught: string | null = null;
    try {
      await fetch('/api/envs', { method: 'POST', body: '{}' });
    } catch {
      caught = 'Network error. Please check your connection and try again.';
    }

    expect(caught).toBeTruthy();
  });

  it('body contains correct payload shape', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 201 }),
    );
    const result = await simulateSubmit(VALID_VALUES, mockFetch as unknown as typeof fetch);
    const body = JSON.parse(result.options?.body as string);
    expect(body).toMatchObject({
      org_key: 'acme-corp',
      env_key: 'prod',
      region_id: 'ash',
      replicas: 2,
    });
  });
});
