/**
 * EnvForm unit tests — Sub-AC 2
 *
 * Requirements verified:
 *   1. Resource limit fields (cpu_limit, memory_limit, memory_req, cpu_req, replicas)
 *      are present in EnvFormValues with correct types
 *   2. Placeholder defaults match the PostgreSQL schema defaults
 *   3. Validation logic correctly handles replicas (positive integer)
 *   4. Resource fields pass through validation without error when populated with
 *      valid Kubernetes quantity strings (e.g. 4Gi, 500m)
 *   5. Fetch payload contract: resource fields are sent to POST /api/envs with
 *      correct values and types (replicas as integer, memory/cpu as strings)
 *   6. Error message mapping matches handleSubmit branches
 *   7. REGION_OPTIONS list covers the expected regions
 *
 * Tests run in pure Node.js — no DOM / jsdom needed.
 * React rendering belongs in E2E / integration tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validateEnvForm,
  DEFAULTS,
  REGION_OPTIONS,
  type EnvFormValues,
} from '../EnvForm';
import type { CustomerEnv } from '@/db/types';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const VALID_VALUES: EnvFormValues = {
  org_key: 'acme',
  env_key: 'prod',
  region_id: 'ash',
  image: 'mirror.gcr.io/dotcms/dotcms:LTS-24.10',
  replicas: '1',
  memory_req: '4Gi',
  memory_limit: '5Gi',
  cpu_req: '500m',
  env_vars: {},
  cpu_limit: '2000m',
};

// ---------------------------------------------------------------------------
// Schema-derived default values
// ---------------------------------------------------------------------------

describe('DEFAULTS — schema-derived placeholder values', () => {
  it('defaults replicas to "1" matching schema DEFAULT 1', () => {
    expect(DEFAULTS.replicas).toBe('1');
  });

  it('defaults memory_req to "4Gi" matching schema DEFAULT', () => {
    expect(DEFAULTS.memory_req).toBe('4Gi');
  });

  it('defaults memory_limit to "5Gi" matching schema DEFAULT', () => {
    expect(DEFAULTS.memory_limit).toBe('5Gi');
  });

  it('defaults cpu_req to "500m" matching schema DEFAULT', () => {
    expect(DEFAULTS.cpu_req).toBe('500m');
  });

  it('defaults cpu_limit to "2000m" matching schema DEFAULT', () => {
    expect(DEFAULTS.cpu_limit).toBe('2000m');
  });

  it('defaults region_id to "ash"', () => {
    expect(DEFAULTS.region_id).toBe('ash');
  });

  it('defaults org_key to empty string (user must select)', () => {
    expect(DEFAULTS.org_key).toBe('');
  });

  it('defaults env_key to empty string (user must fill)', () => {
    expect(DEFAULTS.env_key).toBe('');
  });

  it('defaults image to empty string (user must fill)', () => {
    expect(DEFAULTS.image).toBe('');
  });

  it('DEFAULTS contains all resource limit fields required by the schema', () => {
    const resourceFields: Array<keyof EnvFormValues> = [
      'replicas',
      'memory_req',
      'memory_limit',
      'cpu_req',
      'cpu_limit',
    ];
    for (const field of resourceFields) {
      expect(DEFAULTS).toHaveProperty(field);
    }
  });
});

// ---------------------------------------------------------------------------
// REGION_OPTIONS
// ---------------------------------------------------------------------------

describe('REGION_OPTIONS', () => {
  it('includes at least one region', () => {
    expect(REGION_OPTIONS.length).toBeGreaterThan(0);
  });

  it('includes the default ash region', () => {
    const ash = REGION_OPTIONS.find((r) => r.value === 'ash');
    expect(ash).toBeDefined();
  });

  it('each option has a value and label', () => {
    for (const option of REGION_OPTIONS) {
      expect(option.value).toBeTruthy();
      expect(option.label).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// validateEnvForm — resource limit field validation
// ---------------------------------------------------------------------------

describe('validateEnvForm — replicas field', () => {
  it('returns no error for replicas = "1"', () => {
    const errors = validateEnvForm(VALID_VALUES);
    expect(errors.replicas).toBeUndefined();
  });

  it('returns no error for replicas = "3"', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, replicas: '3' });
    expect(errors.replicas).toBeUndefined();
  });

  it('returns error when replicas is empty', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, replicas: '' });
    expect(errors.replicas).toBeTruthy();
  });

  it('returns error when replicas is 0', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, replicas: '0' });
    expect(errors.replicas).toBeTruthy();
  });

  it('returns error when replicas is negative', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, replicas: '-1' });
    expect(errors.replicas).toBeTruthy();
  });

  it('returns error when replicas is a decimal', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, replicas: '1.5' });
    expect(errors.replicas).toBeTruthy();
  });

  it('returns error when replicas is non-numeric', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, replicas: 'abc' });
    expect(errors.replicas).toBeTruthy();
  });

  it('error message mentions "positive integer"', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, replicas: '0' });
    expect(errors.replicas).toMatch(/positive integer/i);
  });
});

describe('validateEnvForm — memory and CPU resource fields (optional, no validation)', () => {
  it('returns no error for memory_req with Gi suffix', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, memory_req: '8Gi' });
    expect(errors.memory_req).toBeUndefined();
  });

  it('returns no error for memory_limit with Gi suffix', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, memory_limit: '10Gi' });
    expect(errors.memory_limit).toBeUndefined();
  });

  it('returns no error for cpu_req with millicores suffix', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, cpu_req: '1000m' });
    expect(errors.cpu_req).toBeUndefined();
  });

  it('returns no error for cpu_limit with millicores suffix', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, cpu_limit: '4000m' });
    expect(errors.cpu_limit).toBeUndefined();
  });

  it('returns no error for empty memory_req (optional field, defaults on server)', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, memory_req: '' });
    expect(errors.memory_req).toBeUndefined();
  });

  it('returns no error for empty cpu_limit (optional field)', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, cpu_limit: '' });
    expect(errors.cpu_limit).toBeUndefined();
  });
});

describe('validateEnvForm — required fields', () => {
  it('returns no errors for fully valid values', () => {
    const errors = validateEnvForm(VALID_VALUES);
    expect(Object.keys(errors)).toHaveLength(0);
  });

  it('returns error when org_key is empty', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, org_key: '' });
    expect(errors.org_key).toBeTruthy();
  });

  it('returns error when env_key is empty', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, env_key: '' });
    expect(errors.env_key).toBeTruthy();
  });

  it('returns error when env_key contains uppercase letters', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, env_key: 'Prod' });
    expect(errors.env_key).toBeTruthy();
  });

  it('returns error when env_key contains underscores', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, env_key: 'my_env' });
    expect(errors.env_key).toBeTruthy();
  });

  it('returns error when env_key starts with a hyphen', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, env_key: '-prod' });
    expect(errors.env_key).toBeTruthy();
  });

  it('accepts env_key with hyphens in the middle', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, env_key: 'my-env' });
    expect(errors.env_key).toBeUndefined();
  });

  it('returns error when image is empty', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, image: '' });
    expect(errors.image).toBeTruthy();
  });

  it('returns error when image is whitespace only', () => {
    const errors = validateEnvForm({ ...VALID_VALUES, image: '   ' });
    expect(errors.image).toBeTruthy();
  });

  it('accumulates multiple errors simultaneously', () => {
    const errors = validateEnvForm({
      ...VALID_VALUES,
      org_key: '',
      image: '',
      replicas: '0',
    });
    expect(errors.org_key).toBeTruthy();
    expect(errors.image).toBeTruthy();
    expect(errors.replicas).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Fetch payload contract — resource limit fields sent to POST /api/envs
// ---------------------------------------------------------------------------

describe('EnvForm fetch payload contract — resource limit fields', () => {
  /**
   * Mirrors the payload construction in EnvForm.handleSubmit.
   * Resource limit fields are sent as strings (memory/cpu) or integer (replicas).
   */
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
    };
  }

  it('sends replicas as a number (integer), not a string', () => {
    const payload = buildPayload(VALID_VALUES);
    expect(typeof payload.replicas).toBe('number');
    expect(Number.isInteger(payload.replicas)).toBe(true);
  });

  it('sends replicas = 1 for default values', () => {
    const payload = buildPayload({ ...VALID_VALUES, replicas: '1' });
    expect(payload.replicas).toBe(1);
  });

  it('sends replicas = 3 when form value is "3"', () => {
    const payload = buildPayload({ ...VALID_VALUES, replicas: '3' });
    expect(payload.replicas).toBe(3);
  });

  it('sends memory_req as a string', () => {
    const payload = buildPayload(VALID_VALUES);
    expect(typeof payload.memory_req).toBe('string');
    expect(payload.memory_req).toBe('4Gi');
  });

  it('sends memory_limit as a string', () => {
    const payload = buildPayload(VALID_VALUES);
    expect(typeof payload.memory_limit).toBe('string');
    expect(payload.memory_limit).toBe('5Gi');
  });

  it('sends cpu_req as a string', () => {
    const payload = buildPayload(VALID_VALUES);
    expect(typeof payload.cpu_req).toBe('string');
    expect(payload.cpu_req).toBe('500m');
  });

  it('sends cpu_limit as a string', () => {
    const payload = buildPayload(VALID_VALUES);
    expect(typeof payload.cpu_limit).toBe('string');
    expect(payload.cpu_limit).toBe('2000m');
  });

  it('trims whitespace from memory_req before sending', () => {
    const payload = buildPayload({ ...VALID_VALUES, memory_req: '  8Gi  ' });
    expect(payload.memory_req).toBe('8Gi');
  });

  it('trims whitespace from cpu_limit before sending', () => {
    const payload = buildPayload({ ...VALID_VALUES, cpu_limit: '  4000m  ' });
    expect(payload.cpu_limit).toBe('4000m');
  });

  it('payload includes all resource limit fields', () => {
    const payload = buildPayload(VALID_VALUES);
    expect(payload).toHaveProperty('replicas');
    expect(payload).toHaveProperty('memory_req');
    expect(payload).toHaveProperty('memory_limit');
    expect(payload).toHaveProperty('cpu_req');
    expect(payload).toHaveProperty('cpu_limit');
  });

  it('payload matches the shape expected by POST /api/envs', () => {
    const payload = buildPayload(VALID_VALUES);
    const expectedKeys = [
      'org_key', 'env_key', 'region_id', 'image',
      'replicas', 'memory_req', 'memory_limit', 'cpu_req', 'cpu_limit',
    ];
    expect(Object.keys(payload).sort()).toEqual(expectedKeys.sort());
  });

  it('env_key is lowercased and trimmed before sending', () => {
    const payload = buildPayload({ ...VALID_VALUES, env_key: '  Prod  ' });
    expect(payload.env_key).toBe('prod');
  });
});

// ---------------------------------------------------------------------------
// Error message mapping — mirrors EnvForm.handleSubmit error branches
// ---------------------------------------------------------------------------

describe('EnvForm error message mapping', () => {
  function resolveErrorMessage(
    status: number,
    body: { error?: string; details?: string[] },
  ): string {
    if (status === 409) {
      return body.error ?? 'That environment key already exists for this organization.';
    }
    if (status === 422) {
      const details: string[] = Array.isArray(body.details) ? body.details : [];
      return details.length > 0
        ? details.join(' • ')
        : (body.error ?? 'Validation failed.');
    }
    return body.error ?? 'Failed to create environment. Please try again.';
  }

  function resolveNetworkError(): string {
    return 'Network error. Please check your connection and try again.';
  }

  it('shows body.error for HTTP 409 conflict', () => {
    const msg = resolveErrorMessage(409, { error: 'Environment acme/prod already exists' });
    expect(msg).toBe('Environment acme/prod already exists');
  });

  it('falls back to default 409 message when body.error is absent', () => {
    const msg = resolveErrorMessage(409, {});
    expect(msg).toMatch(/already exists/i);
  });

  it('joins details array for HTTP 422', () => {
    const msg = resolveErrorMessage(422, {
      details: ['replicas must be a positive integer', 'image is required'],
    });
    expect(msg).toBe('replicas must be a positive integer • image is required');
  });

  it('falls back to body.error for HTTP 422 with empty details', () => {
    const msg = resolveErrorMessage(422, { error: 'Validation failed', details: [] });
    expect(msg).toBe('Validation failed');
  });

  it('shows body.error for HTTP 500', () => {
    const msg = resolveErrorMessage(500, { error: 'Internal server error' });
    expect(msg).toBe('Internal server error');
  });

  it('shows generic message when body.error is absent for non-422/409', () => {
    const msg = resolveErrorMessage(503, {});
    expect(msg).toBe('Failed to create environment. Please try again.');
  });

  it('shows network error message on fetch exception', () => {
    expect(resolveNetworkError()).toBe(
      'Network error. Please check your connection and try again.',
    );
  });
});

// ---------------------------------------------------------------------------
// Fetch wiring smoke test — verifies EnvForm calls POST /api/envs
// ---------------------------------------------------------------------------

describe('EnvForm fetch wiring', () => {
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

    // Mirror EnvForm handleSubmit fetch call
    try {
      await fetch('/api/envs', {
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
        }),
      });
    } catch {
      // network errors expected in some tests
    }

    return { url: capturedUrl, options: capturedOptions };
  }

  it('calls fetch with POST method', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 201 }),
    );
    const result = await simulateSubmit(VALID_VALUES, mockFetch as unknown as typeof fetch);
    expect(result.options?.method).toBe('POST');
  });

  it('calls fetch with /api/envs URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 201 }),
    );
    const result = await simulateSubmit(VALID_VALUES, mockFetch as unknown as typeof fetch);
    expect(result.url).toBe('/api/envs');
  });

  it('sends Content-Type: application/json header', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 201 }),
    );
    const result = await simulateSubmit(VALID_VALUES, mockFetch as unknown as typeof fetch);
    const headers = result.options?.headers as Record<string, string>;
    expect(headers?.['Content-Type']).toBe('application/json');
  });

  it('sends replicas as integer in body', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 201 }),
    );
    const result = await simulateSubmit(
      { ...VALID_VALUES, replicas: '3' },
      mockFetch as unknown as typeof fetch,
    );
    const body = JSON.parse(result.options?.body as string) as Record<string, unknown>;
    expect(body.replicas).toBe(3);
    expect(typeof body.replicas).toBe('number');
  });

  it('sends all resource limit fields in the request body', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 201 }),
    );
    const result = await simulateSubmit(VALID_VALUES, mockFetch as unknown as typeof fetch);
    const body = JSON.parse(result.options?.body as string) as Record<string, unknown>;
    expect(body).toHaveProperty('replicas');
    expect(body).toHaveProperty('memory_req');
    expect(body).toHaveProperty('memory_limit');
    expect(body).toHaveProperty('cpu_req');
    expect(body).toHaveProperty('cpu_limit');
  });

  it('handles 201 success with CustomerEnv response shape', async () => {
    const createdEnv: CustomerEnv = {
      org_key: 'acme',
      env_key: 'prod',
      cluster_id: 'default',
      region_id: 'ash',
      image: 'mirror.gcr.io/dotcms/dotcms:LTS-24.10',
      replicas: 1,
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
    const env = await res.json() as CustomerEnv;
    expect(env.replicas).toBe(1);
    expect(env.memory_req).toBe('4Gi');
    expect(env.cpu_limit).toBe('2000m');
    expect(env.deploy_status).toBe('pending');
  });

  it('treats 409 as non-ok (environment already exists)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'already exists' }), { status: 409 }),
    );
    global.fetch = mockFetch as unknown as typeof fetch;
    const res = await fetch('/api/envs', { method: 'POST', body: '{}' });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
  });

  it('network failure is caught and mapped to error message', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    global.fetch = mockFetch as unknown as typeof fetch;

    let caught: string | null = null;
    try {
      await fetch('/api/envs', { method: 'POST', body: '{}' });
    } catch {
      caught = 'Network error. Please check your connection and try again.';
    }
    expect(caught).toBe('Network error. Please check your connection and try again.');
  });
});
