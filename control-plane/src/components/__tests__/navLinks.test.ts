/**
 * navLinks unit tests
 *
 * Pure Node.js environment — no DOM / jsdom.
 *
 * Verifies that all navigation URL builders produce the correct URLs so that:
 *   - Breadcrumb links in the detail page reflect the current org/env context
 *   - Sidebar nav links route to the correct views
 *   - Back links on error states route correctly
 *
 * All functions are deterministic pure functions with no side-effects.
 */

import { describe, it, expect } from 'vitest';
import {
  buildEnvsViewUrl,
  buildOrgEnvsUrl,
  buildOrgsViewUrl,
  buildEnvDetailUrl,
  buildBreadcrumbTrail,
  type BreadcrumbItem,
} from '@/lib/navLinks';

// ---------------------------------------------------------------------------
// buildEnvsViewUrl
// ---------------------------------------------------------------------------

describe('buildEnvsViewUrl — Environments list URL', () => {
  it('returns the environments view URL', () => {
    expect(buildEnvsViewUrl()).toBe('/?view=envs');
  });

  it('starts with /', () => {
    expect(buildEnvsViewUrl()).toMatch(/^\//);
  });

  it('contains view=envs', () => {
    expect(buildEnvsViewUrl()).toContain('view=envs');
  });

  it('is stable across multiple calls', () => {
    expect(buildEnvsViewUrl()).toBe(buildEnvsViewUrl());
  });
});

// ---------------------------------------------------------------------------
// buildOrgsViewUrl
// ---------------------------------------------------------------------------

describe('buildOrgsViewUrl — Organizations list URL', () => {
  it('returns the organizations view URL', () => {
    expect(buildOrgsViewUrl()).toBe('/?view=orgs');
  });

  it('starts with /', () => {
    expect(buildOrgsViewUrl()).toMatch(/^\//);
  });

  it('contains view=orgs', () => {
    expect(buildOrgsViewUrl()).toContain('view=orgs');
  });

  it('is distinct from the envs view URL', () => {
    expect(buildOrgsViewUrl()).not.toBe(buildEnvsViewUrl());
  });
});

// ---------------------------------------------------------------------------
// buildOrgEnvsUrl
// ---------------------------------------------------------------------------

describe('buildOrgEnvsUrl — Environments filtered by org URL', () => {
  it('builds URL for simple alphanumeric org key', () => {
    expect(buildOrgEnvsUrl('acme')).toBe('/?view=envs&org_key=acme');
  });

  it('builds URL for hyphenated org key', () => {
    expect(buildOrgEnvsUrl('my-org')).toBe('/?view=envs&org_key=my-org');
  });

  it('URL-encodes org keys with special characters', () => {
    const url = buildOrgEnvsUrl('org with spaces');
    // encodeURIComponent turns spaces into %20
    expect(url).toContain('org%20with%20spaces');
  });

  it('URL-encodes org keys with ampersands to avoid XSS/broken query strings', () => {
    const url = buildOrgEnvsUrl('a&b');
    expect(url).toContain('a%26b');
    expect(url).not.toContain('a&b');
  });

  it('includes view=envs param', () => {
    expect(buildOrgEnvsUrl('acme')).toContain('view=envs');
  });

  it('includes org_key param', () => {
    const url = buildOrgEnvsUrl('globalcorp');
    const parsed = new URL(url, 'http://localhost');
    expect(parsed.searchParams.get('org_key')).toBe('globalcorp');
  });

  it('has both view and org_key params', () => {
    const url = buildOrgEnvsUrl('acme');
    const parsed = new URL(url, 'http://localhost');
    expect(parsed.searchParams.get('view')).toBe('envs');
    expect(parsed.searchParams.get('org_key')).toBe('acme');
  });

  it('differs from the base envs URL', () => {
    expect(buildOrgEnvsUrl('acme')).not.toBe(buildEnvsViewUrl());
  });

  it('produces different URLs for different org keys', () => {
    expect(buildOrgEnvsUrl('acme')).not.toBe(buildOrgEnvsUrl('other'));
  });
});

// ---------------------------------------------------------------------------
// buildEnvDetailUrl
// ---------------------------------------------------------------------------

describe('buildEnvDetailUrl — Environment detail page URL', () => {
  it('builds correct URL for simple keys', () => {
    expect(buildEnvDetailUrl('acme', 'prod')).toBe('/envs/acme/prod');
  });

  it('URL-encodes org key', () => {
    const url = buildEnvDetailUrl('my org', 'prod');
    expect(url).toContain('my%20org');
  });

  it('URL-encodes env key', () => {
    const url = buildEnvDetailUrl('acme', 'prod v2');
    expect(url).toContain('prod%20v2');
  });

  it('starts with /envs/', () => {
    expect(buildEnvDetailUrl('acme', 'prod')).toMatch(/^\/envs\//);
  });

  it('org key appears before env key in path', () => {
    const url = buildEnvDetailUrl('acme', 'prod');
    const orgIdx = url.indexOf('acme');
    const envIdx = url.indexOf('prod');
    expect(orgIdx).toBeLessThan(envIdx);
  });

  it('produces different URLs for different environments', () => {
    expect(buildEnvDetailUrl('acme', 'prod')).not.toBe(buildEnvDetailUrl('acme', 'staging'));
  });
});

// ---------------------------------------------------------------------------
// buildBreadcrumbTrail
// ---------------------------------------------------------------------------

describe('buildBreadcrumbTrail — Breadcrumb trail for env detail page', () => {
  it('returns exactly 3 items', () => {
    const trail = buildBreadcrumbTrail('acme', 'prod');
    expect(trail).toHaveLength(3);
  });

  it('first item is "Environments" with href to envs view', () => {
    const [first] = buildBreadcrumbTrail('acme', 'prod');
    expect(first.label).toBe('Environments');
    expect(first.href).toBe('/?view=envs');
  });

  it('second item is the org key with href to org-filtered envs view', () => {
    const [, second] = buildBreadcrumbTrail('acme', 'prod');
    expect(second.label).toBe('acme');
    expect(second.href).toBe('/?view=envs&org_key=acme');
  });

  it('third item is the env key with no href (current page)', () => {
    const [, , third] = buildBreadcrumbTrail('acme', 'prod');
    expect(third.label).toBe('prod');
    expect(third.href).toBeUndefined();
  });

  it('second item href encodes the org key', () => {
    const [, second] = buildBreadcrumbTrail('my-org', 'prod');
    const parsed = new URL(second.href!, 'http://localhost');
    expect(parsed.searchParams.get('org_key')).toBe('my-org');
  });

  it('first item always links to envs view regardless of org/env', () => {
    const trail1 = buildBreadcrumbTrail('acme', 'prod');
    const trail2 = buildBreadcrumbTrail('other', 'staging');
    expect(trail1[0].href).toBe(trail2[0].href);
  });

  it('second item reflects current org context', () => {
    const trail = buildBreadcrumbTrail('globalcorp', 'prod');
    expect(trail[1].label).toBe('globalcorp');
  });

  it('third item reflects current env context', () => {
    const trail = buildBreadcrumbTrail('acme', 'staging-v2');
    expect(trail[2].label).toBe('staging-v2');
  });

  it('only the last item has no href (is the current page)', () => {
    const trail = buildBreadcrumbTrail('acme', 'prod');
    const itemsWithHref = trail.filter((item: BreadcrumbItem) => item.href !== undefined);
    const itemsWithoutHref = trail.filter((item: BreadcrumbItem) => item.href === undefined);
    expect(itemsWithHref).toHaveLength(2);
    expect(itemsWithoutHref).toHaveLength(1);
    expect(itemsWithoutHref[0].label).toBe('prod');
  });
});

// ---------------------------------------------------------------------------
// Navigation routing contract
// ---------------------------------------------------------------------------

describe('Navigation routing contract', () => {
  it('breadcrumb "Environments" link matches sidebar Environments nav link', () => {
    // Both should point to the same base envs view
    const breadcrumbLink = buildBreadcrumbTrail('acme', 'prod')[0].href;
    const sidebarEnvsLink = buildEnvsViewUrl();
    expect(breadcrumbLink).toBe(sidebarEnvsLink);
  });

  it('breadcrumb org link matches the Back link on error state', () => {
    // The error state "Back to environments" link uses buildOrgEnvsUrl
    const breadcrumbOrgLink = buildBreadcrumbTrail('acme', 'prod')[1].href;
    const backLink = buildOrgEnvsUrl('acme');
    expect(breadcrumbOrgLink).toBe(backLink);
  });

  it('breadcrumb org link contains org context for sidebar sub-item', () => {
    // The sidebar shows a sub-item "↳ {orgKey}" with the same URL
    const breadcrumbOrgLink = buildBreadcrumbTrail('acme', 'prod')[1].href!;
    const sidebarOrgLink = buildOrgEnvsUrl('acme');
    expect(breadcrumbOrgLink).toBe(sidebarOrgLink);
  });

  it('orgs nav link is distinct from envs nav link', () => {
    expect(buildOrgsViewUrl()).not.toBe(buildEnvsViewUrl());
  });

  it('org-filtered env URL includes view param so main page can derive activeView', () => {
    const url = buildOrgEnvsUrl('acme');
    const parsed = new URL(url, 'http://localhost');
    expect(parsed.searchParams.get('view')).toBe('envs');
  });
});
