/**
 * API route authentication helper.
 *
 * Accepts either:
 *   1. A valid NextAuth session (Google OAuth or NEXTAUTH_BYPASS dev user)
 *   2. Authorization: Bearer <API_TOKEN> header (for machine-to-machine calls)
 *
 * Usage in a route handler:
 *   const authError = await requireApiAuth(request);
 *   if (authError) return authError;
 */

import { auth } from '@/auth';

/**
 * Returns null if the request is authenticated, or a 401 Response if not.
 */
export async function requireApiAuth(request: Request): Promise<Response | null> {
  // 1. Check Bearer token first (fast path for machine clients)
  const apiToken = process.env.API_TOKEN;
  if (apiToken) {
    const authHeader = request.headers.get('authorization') ?? '';
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (token === apiToken) return null; // authenticated
    }
  }

  // 2. Fall back to NextAuth session (browser / OAuth users)
  const session = await auth();
  if (session) return null; // authenticated

  // 3. Dev bypass — if NEXTAUTH_BYPASS is set, allow all API calls
  if (process.env.NEXTAUTH_BYPASS === 'true') return null;

  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}
