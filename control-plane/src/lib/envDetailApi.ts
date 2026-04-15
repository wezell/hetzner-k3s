/**
 * envDetailApi — URL builders for the environment detail page API calls.
 *
 * Extracted from src/app/envs/[org]/[env]/page.tsx for testability.
 * All functions are pure, URL-safe, and depend only on string inputs.
 *
 * Route structure:
 *   GET /api/envs/[org_key]/detail?env_key=[env_key]   — fetch full env record
 *   GET /api/envs/[org_key]/status?env_key=[env_key]   — poll live status + logs
 *   PATCH /api/envs/[org_key]/stop?env_key=[env_key]   — stop a running env
 *   PATCH /api/envs/[org_key]/decommission?env_key=... — decommission a stopped env
 *   PATCH /api/envs/[org_key]/detail?env_key=[env_key] — update config fields
 *
 * The [org_key] path segment maps to the [org] dynamic route param.
 * The env_key query param maps to the [env] dynamic route param.
 * Both are URL-encoded to safely handle special characters.
 */

/** GET /api/envs/[org]/detail?env_key=[env] */
export function buildDetailFetchUrl(orgKey: string, envKey: string): string {
  return `/api/envs/${encodeURIComponent(orgKey)}/detail?env_key=${encodeURIComponent(envKey)}`;
}

/** GET /api/envs/[org]/status?env_key=[env]&limit=5 */
export function buildStatusFetchUrl(orgKey: string, envKey: string): string {
  return `/api/envs/${encodeURIComponent(orgKey)}/status?env_key=${encodeURIComponent(envKey)}&limit=5`;
}

/** PATCH /api/envs/[org]/stop?env_key=[env] */
export function buildStopUrl(orgKey: string, envKey: string): string {
  return `/api/envs/${encodeURIComponent(orgKey)}/stop?env_key=${encodeURIComponent(envKey)}`;
}

/** PATCH /api/envs/[org]/decommission?env_key=[env] */
export function buildDecommissionUrl(orgKey: string, envKey: string): string {
  return `/api/envs/${encodeURIComponent(orgKey)}/decommission?env_key=${encodeURIComponent(envKey)}`;
}

/** PATCH /api/envs/[org]/detail?env_key=[env] (settings save) */
export function buildSettingsPatchUrl(orgKey: string, envKey: string): string {
  return `/api/envs/${encodeURIComponent(orgKey)}/detail?env_key=${encodeURIComponent(envKey)}`;
}
