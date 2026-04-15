/**
 * envDetailApi unit tests
 *
 * Pure Node.js environment — no DOM / jsdom.
 *
 * Verifies that all API URL builders for the environment detail page
 * produce correctly structured, URL-safe fetch targets.
 *
 * Architecture contract being tested:
 *   URL path /envs/[org]/[env]
 *     → useParams() → { org: orgKey, env: envKey }
 *     → URL builders → /api/envs/<orgKey>/<action>?env_key=<envKey>
 *
 * Both orgKey (path segment) and envKey (query param) are encodeURIComponent'd
 * to safely handle characters like spaces, slashes, ampersands, etc.
 */

import { describe, it, expect } from 'vitest';
import {
  buildDetailFetchUrl,
  buildStatusFetchUrl,
  buildStopUrl,
  buildDecommissionUrl,
  buildSettingsPatchUrl,
} from '@/lib/envDetailApi';

// ---------------------------------------------------------------------------
// buildDetailFetchUrl — GET /api/envs/[org]/detail?env_key=[env]
// ---------------------------------------------------------------------------

describe('buildDetailFetchUrl — GET /api/envs/[org]/detail', () => {
  it('builds the correct URL for simple ASCII keys', () => {
    expect(buildDetailFetchUrl('acme', 'prod')).toBe(
      '/api/envs/acme/detail?env_key=prod'
    );
  });

  it('URL-encodes spaces in orgKey (path segment)', () => {
    const url = buildDetailFetchUrl('acme corp', 'prod');
    expect(url).toContain('/api/envs/acme%20corp/');
    expect(url).not.toContain(' ');
  });

  it('URL-encodes spaces in envKey (query param)', () => {
    const url = buildDetailFetchUrl('acme', 'prod env');
    expect(url).toContain('env_key=prod%20env');
    expect(url).not.toContain(' ');
  });

  it('URL-encodes ampersands in envKey to prevent query param injection', () => {
    const url = buildDetailFetchUrl('acme', 'env&evil=1');
    expect(url).toContain('env_key=env%26evil%3D1');
    expect(url).not.toContain('evil=1');
  });

  it('URL-encodes slashes in orgKey', () => {
    const url = buildDetailFetchUrl('acme/sub', 'prod');
    expect(url).toContain('/api/envs/acme%2Fsub/');
  });

  it('produces a URL starting with /api/envs/', () => {
    expect(buildDetailFetchUrl('org', 'env')).toMatch(/^\/api\/envs\//);
  });

  it('always includes the detail segment', () => {
    expect(buildDetailFetchUrl('org', 'env')).toContain('/detail');
  });

  it('always includes env_key query param', () => {
    expect(buildDetailFetchUrl('org', 'env')).toContain('env_key=');
  });

  it('is stable across multiple calls with same inputs', () => {
    const url1 = buildDetailFetchUrl('acme', 'prod');
    const url2 = buildDetailFetchUrl('acme', 'prod');
    expect(url1).toBe(url2);
  });

  it('differentiates between different org keys', () => {
    const url1 = buildDetailFetchUrl('acme', 'prod');
    const url2 = buildDetailFetchUrl('globex', 'prod');
    expect(url1).not.toBe(url2);
  });

  it('differentiates between different env keys', () => {
    const url1 = buildDetailFetchUrl('acme', 'prod');
    const url2 = buildDetailFetchUrl('acme', 'staging');
    expect(url1).not.toBe(url2);
  });

  it('maps useParams org/env segments correctly to URL path and query', () => {
    // Simulates: const { org: orgKey, env: envKey } = useParams()
    // where URL is /envs/acme/prod
    const orgKey = 'acme'; // from URL path [org] segment
    const envKey = 'prod'; // from URL path [env] segment
    const fetchUrl = buildDetailFetchUrl(orgKey, envKey);
    // orgKey becomes path segment in /api/envs/[org]/detail
    expect(fetchUrl).toContain(`/api/envs/${orgKey}/detail`);
    // envKey becomes query param env_key
    expect(fetchUrl).toContain(`env_key=${envKey}`);
  });
});

// ---------------------------------------------------------------------------
// buildStatusFetchUrl — GET /api/envs/[org]/status?env_key=[env]&limit=5
// ---------------------------------------------------------------------------

describe('buildStatusFetchUrl — GET /api/envs/[org]/status', () => {
  it('builds the correct URL for simple ASCII keys', () => {
    expect(buildStatusFetchUrl('acme', 'prod')).toBe(
      '/api/envs/acme/status?env_key=prod&limit=5'
    );
  });

  it('includes limit=5 for log polling', () => {
    expect(buildStatusFetchUrl('acme', 'prod')).toContain('limit=5');
  });

  it('URL-encodes special characters in both params', () => {
    const url = buildStatusFetchUrl('acme corp', 'prod&env');
    expect(url).toContain('acme%20corp');
    expect(url).toContain('prod%26env');
    expect(url).not.toContain(' ');
  });

  it('always includes the status segment', () => {
    expect(buildStatusFetchUrl('org', 'env')).toContain('/status');
  });

  it('always includes env_key query param', () => {
    expect(buildStatusFetchUrl('org', 'env')).toContain('env_key=');
  });

  it('starts with /api/envs/', () => {
    expect(buildStatusFetchUrl('org', 'env')).toMatch(/^\/api\/envs\//);
  });
});

// ---------------------------------------------------------------------------
// buildStopUrl — PATCH /api/envs/[org]/stop?env_key=[env]
// ---------------------------------------------------------------------------

describe('buildStopUrl — PATCH /api/envs/[org]/stop', () => {
  it('builds the correct URL for simple ASCII keys', () => {
    expect(buildStopUrl('acme', 'prod')).toBe(
      '/api/envs/acme/stop?env_key=prod'
    );
  });

  it('always includes the stop segment', () => {
    expect(buildStopUrl('org', 'env')).toContain('/stop');
  });

  it('URL-encodes special characters in orgKey', () => {
    const url = buildStopUrl('acme corp', 'prod');
    expect(url).toContain('acme%20corp');
  });

  it('URL-encodes special characters in envKey', () => {
    const url = buildStopUrl('acme', 'prod&env');
    expect(url).toContain('prod%26env');
  });

  it('always includes env_key query param', () => {
    expect(buildStopUrl('org', 'env')).toContain('env_key=');
  });

  it('starts with /api/envs/', () => {
    expect(buildStopUrl('org', 'env')).toMatch(/^\/api\/envs\//);
  });
});

// ---------------------------------------------------------------------------
// buildDecommissionUrl — PATCH /api/envs/[org]/decommission?env_key=[env]
// ---------------------------------------------------------------------------

describe('buildDecommissionUrl — PATCH /api/envs/[org]/decommission', () => {
  it('builds the correct URL for simple ASCII keys', () => {
    expect(buildDecommissionUrl('acme', 'prod')).toBe(
      '/api/envs/acme/decommission?env_key=prod'
    );
  });

  it('always includes the decommission segment', () => {
    expect(buildDecommissionUrl('org', 'env')).toContain('/decommission');
  });

  it('URL-encodes special characters', () => {
    const url = buildDecommissionUrl('acme corp', 'prod&env');
    expect(url).toContain('acme%20corp');
    expect(url).toContain('prod%26env');
  });

  it('always includes env_key query param', () => {
    expect(buildDecommissionUrl('org', 'env')).toContain('env_key=');
  });
});

// ---------------------------------------------------------------------------
// buildSettingsPatchUrl — PATCH /api/envs/[org]/detail?env_key=[env]
// ---------------------------------------------------------------------------

describe('buildSettingsPatchUrl — PATCH /api/envs/[org]/detail (settings save)', () => {
  it('builds the correct URL for simple ASCII keys', () => {
    expect(buildSettingsPatchUrl('acme', 'prod')).toBe(
      '/api/envs/acme/detail?env_key=prod'
    );
  });

  it('always includes the detail segment', () => {
    expect(buildSettingsPatchUrl('org', 'env')).toContain('/detail');
  });

  it('URL-encodes special characters', () => {
    const url = buildSettingsPatchUrl('acme corp', 'prod&env');
    expect(url).toContain('acme%20corp');
    expect(url).toContain('prod%26env');
  });

  it('produces the same URL as buildDetailFetchUrl (same endpoint, different method)', () => {
    // Both GET and PATCH use the same /api/envs/[org]/detail?env_key= endpoint.
    // The HTTP method is controlled by the fetch options, not the URL.
    const getUrl = buildDetailFetchUrl('acme', 'prod');
    const patchUrl = buildSettingsPatchUrl('acme', 'prod');
    expect(getUrl).toBe(patchUrl);
  });
});

// ---------------------------------------------------------------------------
// Cross-function URL routing contract
// ---------------------------------------------------------------------------

describe('URL routing contract — org/env params propagation', () => {
  const ORG_KEY = 'test-org';
  const ENV_KEY = 'test-env';

  it('all URL builders embed orgKey as the path segment after /api/envs/', () => {
    const builders = [
      buildDetailFetchUrl,
      buildStatusFetchUrl,
      buildStopUrl,
      buildDecommissionUrl,
      buildSettingsPatchUrl,
    ];

    for (const builder of builders) {
      const url = builder(ORG_KEY, ENV_KEY);
      expect(url).toContain(`/api/envs/${ORG_KEY}/`);
    }
  });

  it('all URL builders include env_key query param with envKey value', () => {
    const builders = [
      buildDetailFetchUrl,
      buildStatusFetchUrl,
      buildStopUrl,
      buildDecommissionUrl,
      buildSettingsPatchUrl,
    ];

    for (const builder of builders) {
      const url = builder(ORG_KEY, ENV_KEY);
      expect(url).toContain(`env_key=${ENV_KEY}`);
    }
  });

  it('URL-encoded orgKey appears in path segment (not query) across all builders', () => {
    const specialOrg = 'org with spaces';
    const encoded = encodeURIComponent(specialOrg); // 'org%20with%20spaces'

    const builders = [
      buildDetailFetchUrl,
      buildStatusFetchUrl,
      buildStopUrl,
      buildDecommissionUrl,
      buildSettingsPatchUrl,
    ];

    for (const builder of builders) {
      const url = builder(specialOrg, 'env');
      // Encoded org appears in path before the query string
      const pathPart = url.split('?')[0];
      expect(pathPart).toContain(encoded);
    }
  });

  it('URL-encoded envKey appears in query string (not path) across all builders', () => {
    const specialEnv = 'env&with=special';
    const encoded = encodeURIComponent(specialEnv);

    const builders = [
      buildDetailFetchUrl,
      buildStatusFetchUrl,
      buildStopUrl,
      buildDecommissionUrl,
      buildSettingsPatchUrl,
    ];

    for (const builder of builders) {
      const url = builder('acme', specialEnv);
      // Encoded env appears in query string
      const queryPart = url.split('?')[1] ?? '';
      expect(queryPart).toContain(encoded);
    }
  });

  it('all URLs can be parsed as valid URL objects (relative to a base)', () => {
    const base = 'http://localhost:3000';
    const builders = [
      buildDetailFetchUrl,
      buildStatusFetchUrl,
      buildStopUrl,
      buildDecommissionUrl,
      buildSettingsPatchUrl,
    ];

    for (const builder of builders) {
      const url = builder('acme', 'prod');
      expect(() => new URL(url, base)).not.toThrow();
    }
  });

  it('env_key query param is correctly parsed by URLSearchParams', () => {
    // Validates that the URL can be round-tripped through URLSearchParams
    const envKey = 'my-env+key&special';
    const url = buildDetailFetchUrl('acme', envKey);
    const parsed = new URL(url, 'http://localhost');
    expect(parsed.searchParams.get('env_key')).toBe(envKey);
  });
});
