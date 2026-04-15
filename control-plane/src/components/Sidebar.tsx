'use client';

import { useRouter, useSearchParams } from 'next/navigation';

type View = 'orgs' | 'envs';

const NAV_ITEMS: { view: View; label: string; icon: string }[] = [
  {
    view: 'orgs',
    label: 'Organizations',
    icon: 'M3 6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6Zm8 10a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z',
  },
  {
    view: 'envs',
    label: 'Environments',
    icon: 'M5 12H3l9-9 9 9h-2M5 12v7a1 1 0 0 0 1 1h4v-4h4v4h4a1 1 0 0 0 1-1v-7',
  },
];

interface SidebarProps {
  /** Currently active view */
  activeView: View;
}

export default function Sidebar({ activeView }: SidebarProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function navigate(view: View) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('view', view);
    router.push(`/?${params.toString()}`);
  }

  return (
    <nav aria-label="Main navigation">
      <ul className="menu menu-md w-64 p-4 gap-1">
        <li className="menu-title text-xs uppercase tracking-wider opacity-60 px-2 py-1">
          Navigation
        </li>
        {NAV_ITEMS.map(({ view, label, icon }) => (
          <li key={view}>
            <button
              onClick={() => navigate(view)}
              className={activeView === view ? 'active' : ''}
              aria-current={activeView === view ? 'page' : undefined}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="w-5 h-5 shrink-0"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
              </svg>
              {label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export type { View };
