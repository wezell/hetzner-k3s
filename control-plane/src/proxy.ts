export { auth as proxy } from "@/auth";

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     * - api/* (API routes handle their own auth)
     */
    "/((?!_next/static|_next/image|favicon\\.ico|api/).*)",
  ],
};
