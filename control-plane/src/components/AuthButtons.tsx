'use client';

import { useSession, signIn, signOut } from 'next-auth/react';

/**
 * Renders a Sign In button when the user is unauthenticated, or a user
 * identity badge + Sign Out button when authenticated.
 */
export default function AuthButtons() {
  const { data: session, status } = useSession();

  if (status === 'loading') {
    return (
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-700" />
        <div className="h-4 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
      </div>
    );
  }

  if (!session?.user) {
    return <SignInButton />;
  }

  const displayName = session.user.name ?? session.user.email ?? 'User';
  const initials = displayName
    .split(' ')
    .slice(0, 2)
    .map((n) => n[0])
    .join('')
    .toUpperCase();

  return (
    <div className="flex items-center gap-3">
      {/* Avatar: Google profile image or initials fallback */}
      {session.user.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={session.user.image}
          alt={displayName}
          referrerPolicy="no-referrer"
          className="h-8 w-8 rounded-full object-cover ring-1 ring-zinc-200 dark:ring-zinc-700"
        />
      ) : (
        <span
          aria-label={displayName}
          className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white"
        >
          {initials}
        </span>
      )}

      {/* User name */}
      <span
        className="text-sm text-zinc-700 dark:text-zinc-300"
        title={session.user.email ?? undefined}
      >
        {displayName}
      </span>

      <SignOutButton />
    </div>
  );
}

/** Standalone Sign In button — calls NextAuth signIn with the Google provider. */
export function SignInButton() {
  return (
    <button
      onClick={() => signIn('google')}
      className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
    >
      Sign in with Google
    </button>
  );
}

/** Standalone Sign Out button — calls NextAuth signOut. */
export function SignOutButton() {
  return (
    <button
      onClick={() => signOut()}
      className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      Sign out
    </button>
  );
}
