'use client';

import AuthButtons from '@/components/AuthButtons';

/**
 * Shared application header rendered on every page via the root layout.
 * Contains the app title/description and the auth controls (sign-in / sign-out).
 */
export default function Header() {
  return (
    <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mx-auto max-w-4xl px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            dotCMS Control Plane
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Kubernetes tenant provisioning &amp; lifecycle management
          </p>
        </div>
        <AuthButtons />
      </div>
    </header>
  );
}
