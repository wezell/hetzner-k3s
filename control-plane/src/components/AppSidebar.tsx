'use client';

import Link from 'next/link';

interface AppSidebarProps {
  /** Which nav item to highlight as active */
  activeView?: 'orgs' | 'envs';
}

export default function AppSidebar({ activeView }: AppSidebarProps) {
  return (
    <aside className="bg-base-100 border-r border-base-300 min-h-full w-64 flex flex-col">
      <div className="p-4 border-b border-base-300">
        <span className="text-sm font-semibold uppercase tracking-wider text-base-content/60">
          Control Plane
        </span>
      </div>
      <nav aria-label="Main navigation" className="flex-1 py-3 flex flex-col gap-1 px-3">
        <Link
          href="/?view=orgs"
          className={`btn btn-sm justify-start w-full font-normal ${activeView === 'orgs' ? 'btn-primary' : 'btn-ghost'}`}
          aria-current={activeView === 'orgs' ? 'page' : undefined}
        >
          Organizations
        </Link>
        <Link
          href="/?view=envs"
          className={`btn btn-sm justify-start w-full font-normal ${activeView === 'envs' ? 'btn-primary' : 'btn-ghost'}`}
          aria-current={activeView === 'envs' ? 'page' : undefined}
        >
          Environments
        </Link>
      </nav>
    </aside>
  );
}
