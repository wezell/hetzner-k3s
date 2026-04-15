/**
 * Environment list search URL utilities.
 *
 * Extracted from EnvList for independent testability.
 * The API endpoint at /api/envs accepts:
 *   ?org_key=<key>   — exact match on org_key (context filter from org click)
 *   ?name=<pattern>  — wildcard match on env_key (e.g. "prod*", "*staging*")
 *
 * Both params are optional and can be combined simultaneously for dual-field
 * filtering: ?org_key=acme&name=prod* narrows to Acme's environments matching
 * the name pattern.
 */

/**
 * Build the /api/envs URL for dual-field search.
 *
 * Both arguments are independent — either, neither, or both may be provided.
 * Whitespace-only values are treated as absent (no param emitted).
 *
 * @param orgSearch   Exact org_key to filter by (empty = no org filter)
 * @param nameSearch  Wildcard env_key pattern (empty = no name filter)
 */
export function buildEnvUrl(orgSearch: string, nameSearch: string): string {
  const params = new URLSearchParams();
  if (orgSearch.trim()) params.set('org_key', orgSearch.trim());
  if (nameSearch.trim()) params.set('name', nameSearch.trim());
  const qs = params.toString();
  return qs ? `/api/envs?${qs}` : '/api/envs';
}
