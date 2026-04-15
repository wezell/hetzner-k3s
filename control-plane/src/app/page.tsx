'use client';

import { Suspense, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import OrgList from '@/components/OrgList';
import CreateOrgModal from '@/components/CreateOrgModal';
import EnvList from '@/components/EnvList';
import CreateEnvModal from '@/components/CreateEnvModal';
import AuthButtons from '@/components/AuthButtons';
import AppSidebar from '@/components/AppSidebar';
import type { CustomerOrg, CustomerEnv } from '@/db/types';

type View = 'orgs' | 'envs';

// ── Inner component that uses useSearchParams ──────────────────────────────

function HomeInner() {
  const searchParams = useSearchParams();
  const router = useRouter();

  // Derive active view from URL; default to 'orgs'
  const rawView = searchParams.get('view');
  const activeView: View = rawView === 'envs' ? 'envs' : 'orgs';

  // Optional initial search query — set when user clicks an org row
  const qFilter = searchParams.get('q') ?? undefined;

  // Refresh keys bumped after successful create actions
  const [orgRefreshKey, setOrgRefreshKey] = useState(0);
  const [envRefreshKey, setEnvRefreshKey] = useState(0);

  // Modal open/close state
  const [orgModalOpen, setOrgModalOpen] = useState(false);
  const [envModalOpen, setEnvModalOpen] = useState(false);

  function handleOrgCreated(_org: CustomerOrg) {
    setOrgRefreshKey((k) => k + 1);
  }

  function handleEnvCreated(_env: CustomerEnv) {
    setEnvRefreshKey((k) => k + 1);
  }

  function navigate(view: View, extra?: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('view', view);
    // Clear q when switching views manually (not via row click)
    if (!extra?.q) params.delete('q');
    params.delete('org_key'); // no longer used
    if (extra) {
      for (const [k, v] of Object.entries(extra)) params.set(k, v);
    }
    router.push(`/?${params.toString()}`);
  }

  function handleOrgRowClick(org: import('@/db/types').CustomerOrg) {
    // Pass org_key as ?q= so it populates the envs search box
    navigate('envs', { q: org.org_key });
  }

  return (
    /*
     * DaisyUI drawer pattern:
     * - Mobile: hidden sidebar revealed by hamburger toggle (drawer-toggle checkbox)
     * - lg+: drawer-open keeps sidebar permanently visible
     */
    <div className="drawer lg:drawer-open min-h-screen">
      {/* Hidden checkbox that controls mobile drawer open/close */}
      <input id="main-drawer" type="checkbox" className="drawer-toggle" />

      {/* ── Main content area ───────────────────────────────────────────── */}
      <div className="drawer-content flex flex-col">
        {/* Top navbar (contains hamburger on mobile + app title + auth) */}
        <header className="navbar bg-base-100 border-b border-base-300 sticky top-0 z-10 shadow-sm">
          {/* Hamburger — only visible on mobile (hidden lg+) */}
          <div className="flex-none lg:hidden">
            <label
              htmlFor="main-drawer"
              aria-label="Open sidebar menu"
              className="btn btn-square btn-ghost"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="w-5 h-5"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
                />
              </svg>
            </label>
          </div>

          {/* App title */}
          <div className="flex-1 px-2">
            <span className="text-base font-semibold">dotCMS Control Plane</span>
            <span className="hidden sm:inline text-sm text-base-content/60 ml-2">
              Kubernetes tenant provisioning &amp; lifecycle management
            </span>
          </div>

          {/* Auth controls */}
          <div className="flex-none">
            <AuthButtons />
          </div>
        </header>

        {/* Page body */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8">
          {activeView === 'orgs' && (
            <section aria-labelledby="orgs-heading">
              {/* Section header row: title + New Org button */}
              <div className="flex items-center justify-between mb-6">
                <h2 id="orgs-heading" className="text-xl font-semibold">
                  Organizations
                </h2>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => setOrgModalOpen(true)}
                >
                  {/* Plus icon */}
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={2}
                    stroke="currentColor"
                    className="w-4 h-4"
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                  New Org
                </button>
              </div>

              <OrgList refreshKey={orgRefreshKey} onOrgClick={handleOrgRowClick} />

              {/* Modal-based create flow */}
              <CreateOrgModal
                open={orgModalOpen}
                onClose={() => setOrgModalOpen(false)}
                onSuccess={(org) => {
                  handleOrgCreated(org);
                  setOrgModalOpen(false);
                }}
              />
            </section>
          )}

          {activeView === 'envs' && (
            <section aria-labelledby="envs-heading">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 id="envs-heading" className="text-xl font-semibold">
                    Environments
                  </h2>
                  {qFilter && (
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-sm text-base-content/60">Searching:</span>
                      <span className="badge badge-outline badge-sm font-mono">{qFilter}</span>
                      <button
                        type="button"
                        className="btn btn-xs btn-ghost"
                        onClick={() => navigate('envs')}
                        aria-label="Clear search"
                      >
                        ✕ Clear
                      </button>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => setEnvModalOpen(true)}
                >
                  {/* Plus icon */}
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={2}
                    stroke="currentColor"
                    className="w-4 h-4"
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                  New Environment
                </button>
              </div>
              <EnvList refreshKey={envRefreshKey} initialQuery={qFilter} />

              {/* Modal-based create flow */}
              <CreateEnvModal
                open={envModalOpen}
                onClose={() => setEnvModalOpen(false)}
                orgKey={qFilter}
                onSuccess={(env) => {
                  handleEnvCreated(env);
                  setEnvModalOpen(false);
                }}
              />
            </section>
          )}
        </main>
      </div>

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <div className="drawer-side z-20">
        {/* Overlay that closes the drawer when tapped on mobile */}
        <label
          htmlFor="main-drawer"
          aria-label="Close sidebar menu"
          className="drawer-overlay"
        />

        {/* Sidebar panel */}
        <AppSidebar activeView={activeView} />
      </div>
    </div>
  );
}

// ── Default export wrapped in Suspense for useSearchParams ─────────────────

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen">
          <span className="loading loading-spinner loading-lg" />
        </div>
      }
    >
      <HomeInner />
    </Suspense>
  );
}
