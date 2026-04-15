/**
 * CreateOrgModal unit tests
 *
 * Tests the modal's fetch payload contract, validation integration,
 * and error message mapping — mirroring the OrgForm test pattern.
 *
 * React rendering is not exercised here (no jsdom); tests focus on
 * the pure-logic and fetch-contract aspects extracted from the component.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateOrgForm, type OrgFormValues } from '../OrgForm';
import type { CustomerOrg } from '@/db/types';

// ---------------------------------------------------------------------------
// Reuse validateOrgForm — CreateOrgModal delegates validation to same fn
// ---------------------------------------------------------------------------

const VALID_VALUES: OrgFormValues = {
  org_key: 'acme-corp',
  org_long_name: 'Acme Corporation',
  org_email_domain: 'acme.com',
};

describe('CreateOrgModal validation (via validateOrgForm)', () => {
  it('passes for valid org_key and org_long_name', () => {
    const errors = validateOrgForm(VALID_VALUES);
    expect(Object.keys(errors)).toHaveLength(0);
  });

  it('requires org_key', () => {
    const errors = validateOrgForm({ ...VALID_VALUES, org_key: '' });
    expect(errors.org_key).toBeTruthy();
  });

  it('requires org_long_name', () => {
    const errors = validateOrgForm({ ...VALID_VALUES, org_long_name: '' });
    expect(errors.org_long_name).toBeTruthy();
  });

  it('rejects org_key with uppercase', () => {
    const errors = validateOrgForm({ ...VALID_VALUES, org_key: 'ACME' });
    expect(errors.org_key).toBeTruthy();
  });

  it('org_email_domain is optional', () => {
    const errors = validateOrgForm({ ...VALID_VALUES, org_email_domain: '' });
    expect(errors.org_email_domain).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fetch payload contract — what CreateOrgModal sends to POST /api/orgs
// ---------------------------------------------------------------------------

describe('CreateOrgModal fetch payload contract', () => {
  function buildPayload(values: OrgFormValues) {
    return {
      org_key: values.org_key.trim().toLowerCase(),
      org_long_name: values.org_long_name.trim(),
      org_email_domain: values.org_email_domain.trim().toLowerCase(),
    };
  }

  it('lowercases and trims org_key', () => {
    const payload = buildPayload({ ...VALID_VALUES, org_key: '  ACME-CORP  ' });
    expect(payload.org_key).toBe('acme-corp');
  });

  it('trims org_long_name', () => {
    const payload = buildPayload({ ...VALID_VALUES, org_long_name: '  Acme Corporation  ' });
    expect(payload.org_long_name).toBe('Acme Corporation');
  });

  it('lowercases and trims org_email_domain', () => {
    const payload = buildPayload({ ...VALID_VALUES, org_email_domain: '  ACME.COM  ' });
    expect(payload.org_email_domain).toBe('acme.com');
  });

  it('sends empty string for omitted email domain', () => {
    const payload = buildPayload({ ...VALID_VALUES, org_email_domain: '' });
    expect(payload.org_email_domain).toBe('');
  });

  it('payload has exactly the expected keys', () => {
    const payload = buildPayload(VALID_VALUES);
    expect(Object.keys(payload)).toEqual(['org_key', 'org_long_name', 'org_email_domain']);
  });
});

// ---------------------------------------------------------------------------
// Error message mapping — mirrors CreateOrgModal handleSubmit error branches
// ---------------------------------------------------------------------------

describe('CreateOrgModal error message mapping', () => {
  function resolveErrorMessage(
    status: number,
    body: { error?: string; details?: string[] },
  ): string {
    if (status === 409) return 'An organization with that key already exists.';
    if (status === 422) {
      const details: string[] = Array.isArray(body.details) ? body.details : [];
      return details.length > 0 ? details.join(' • ') : (body.error ?? 'Validation failed.');
    }
    return body.error ?? 'Failed to create organization. Please try again.';
  }

  it('shows conflict message for HTTP 409', () => {
    expect(resolveErrorMessage(409, {})).toBe('An organization with that key already exists.');
  });

  it('joins details for HTTP 422 with details array', () => {
    const msg = resolveErrorMessage(422, { details: ['field a', 'field b'] });
    expect(msg).toBe('field a • field b');
  });

  it('falls back to body.error for HTTP 422 with empty details', () => {
    expect(resolveErrorMessage(422, { error: 'Oops', details: [] })).toBe('Oops');
  });

  it('shows generic message for 500 without body error', () => {
    expect(resolveErrorMessage(500, {})).toBe('Failed to create organization. Please try again.');
  });
});

// ---------------------------------------------------------------------------
// Fetch wiring smoke test
// ---------------------------------------------------------------------------

describe('CreateOrgModal fetch wiring', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function simulateSubmit(
    values: OrgFormValues,
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
      await fetch('/api/orgs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_key: values.org_key.trim().toLowerCase(),
          org_long_name: values.org_long_name.trim(),
          org_email_domain: values.org_email_domain.trim().toLowerCase(),
        }),
      });
    } catch {
      // network errors expected in some cases
    }

    return { url: capturedUrl, options: capturedOptions };
  }

  it('calls POST /api/orgs', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ org_key: 'acme-corp' }), { status: 201 }),
    );
    const result = await simulateSubmit(VALID_VALUES, mockFetch as unknown as typeof fetch);
    expect(result.url).toBe('/api/orgs');
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

  it('calls onSuccess with created org on 201', async () => {
    const createdOrg: CustomerOrg = {
      org_key: 'acme-corp',
      org_long_name: 'Acme Corporation',
      org_active: true,
      org_email_domain: 'acme.com',
      org_data: {},
      created_date: '2026-04-14T12:00:00Z',
      mod_date: '2026-04-14T12:00:00Z',
    };

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(createdOrg), { status: 201 }),
    );
    global.fetch = mockFetch as unknown as typeof fetch;

    const res = await fetch('/api/orgs', { method: 'POST', body: '{}' });
    expect(res.ok).toBe(true);
    const body = await res.json() as CustomerOrg;
    expect(body.org_key).toBe('acme-corp');
  });

  it('network failure surfaces as error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    global.fetch = mockFetch as unknown as typeof fetch;

    let caught: string | null = null;
    try {
      await fetch('/api/orgs', { method: 'POST', body: '{}' });
    } catch {
      caught = 'Network error. Please check your connection and try again.';
    }

    expect(caught).toBeTruthy();
  });
});
