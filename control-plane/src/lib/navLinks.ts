/**
 * navLinks — navigation URL builders for the control-plane UI.
 *
 * All URLs are relative to the app root.  Pure functions with no side-effects,
 * extracted here so they can be tested independently of React components.
 *
 * Navigation architecture:
 *   / (root page)   — rendered by src/app/page.tsx
 *     ?view=orgs    — Organizations section (default)
 *     ?view=envs    — Environments section
 *     ?view=envs&org_key=X — Environments filtered by org X
 *
 *   /envs/[org]/[env] — Environment detail page
 *     breadcrumb: Environments → org → current env
 */

/**
 * URL for the Environments list view (no org filter).
 * Used in breadcrumb first item and sidebar nav.
 */
export function buildEnvsViewUrl(): string {
  return '/?view=envs';
}

/**
 * URL for the Environments list pre-filtered by a specific org.
 * Used in breadcrumb second item (org name) and Back links on the detail page.
 *
 * @param orgKey - The org_key to filter by (must be non-empty).
 */
export function buildOrgEnvsUrl(orgKey: string): string {
  return `/?view=envs&org_key=${encodeURIComponent(orgKey)}`;
}

/**
 * URL for the Organizations list view.
 * Used in the detail page sidebar and main sidebar nav.
 */
export function buildOrgsViewUrl(): string {
  return '/?view=orgs';
}

/**
 * URL for the environment detail page.
 *
 * @param orgKey - The org the environment belongs to.
 * @param envKey - The environment key.
 */
export function buildEnvDetailUrl(orgKey: string, envKey: string): string {
  return `/envs/${encodeURIComponent(orgKey)}/${encodeURIComponent(envKey)}`;
}

/**
 * Build the breadcrumb trail for the environment detail page.
 *
 * Returns an array of breadcrumb items in order:
 *   1. "Environments" → /?view=envs
 *   2. orgKey → /?view=envs&org_key=orgKey
 *   3. envKey (current page — no href)
 *
 * @param orgKey - The org the environment belongs to.
 * @param envKey - The environment key (current page).
 */
export interface BreadcrumbItem {
  label: string;
  href?: string; // undefined for the current (last) item
}

export function buildBreadcrumbTrail(
  orgKey: string,
  envKey: string,
): BreadcrumbItem[] {
  return [
    { label: 'Environments', href: buildEnvsViewUrl() },
    { label: orgKey, href: buildOrgEnvsUrl(orgKey) },
    { label: envKey }, // current page — no href
  ];
}
