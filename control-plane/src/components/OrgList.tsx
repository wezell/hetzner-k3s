'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CustomerOrg } from '@/db/types';
import OrgEditModal from '@/components/OrgEditModal';
import ConfirmDeleteModal from '@/components/ConfirmDeleteModal';
import { useToast } from '@/hooks/useToast';
import Toast from '@/components/Toast';

interface OrgListProps {
  /** Bump this number to trigger a re-fetch (e.g. after a successful create). */
  refreshKey?: number;
  /** Called when the user clicks an org row — use to navigate to the envs view. */
  onOrgClick?: (org: CustomerOrg) => void;
}

type FetchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; orgs: CustomerOrg[] }
  | { status: 'error'; message: string };

/** Format an ISO-8601 date string into a locale-friendly compact string */
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Build the /api/orgs URL with optional id and name filter query params */
function buildUrl(query: string): string {
  const params = new URLSearchParams();
  if (query.trim()) params.set('q', query.trim());
  const qs = params.toString();
  return qs ? `/api/orgs?${qs}` : '/api/orgs';
}

export default function OrgList({ refreshKey = 0, onOrgClick }: OrgListProps) {
  const [fetchState, setFetchState] = useState<FetchState>({ status: 'idle' });
  const { toast, showToast, clearToast } = useToast();
  const [editOrg, setEditOrg] = useState<CustomerOrg | null>(null);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [deleteOrg, setDeleteOrg] = useState<CustomerOrg | null>(null);
  const [query, setQuery] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const loadOrgs = useCallback(
    async (q: string) => {
      // Cancel any in-flight request
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setFetchState({ status: 'loading' });

      try {
        const res = await fetch(buildUrl(q), { signal: controller.signal });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setFetchState({
            status: 'error',
            message: (body as { error?: string }).error ?? `Server error ${res.status}`,
          });
          return;
        }
        const orgs: CustomerOrg[] = await res.json();
        setFetchState({ status: 'success', orgs });
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setFetchState({
          status: 'error',
          message: 'Network error. Could not load organizations.',
        });
      }
    },
    [],
  );

  // Debounce search inputs — wait 300 ms after the last keystroke
  useEffect(() => {
    const timer = setTimeout(() => {
      loadOrgs(query);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Reload immediately whenever refreshKey changes (e.g. after create)
  useEffect(() => {
    loadOrgs(query);
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // Surface load errors as toasts
  useEffect(() => {
    if (fetchState.status === 'error') showToast(fetchState.message, 'error');
  }, [fetchState, showToast]);

  const handleClearSearch = () => setQuery('');
  const hasActiveSearch = query.trim() !== '';

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4">
      {/* ── Unified search bar ────────────────────────────────────────────── */}
      <div
        role="search"
        aria-label="Search organizations"
        className="flex gap-2 items-center"
      >
        <input
          id="org-search"
          type="text"
          className="input input-sm flex-1"
          placeholder="Search by ID or name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search organizations by ID or name"
        />
        {hasActiveSearch && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={handleClearSearch}
            aria-label="Clear search"
          >
            Clear
          </button>
        )}
      </div>

      {/* ── Results area ─────────────────────────────────────────────────── */}
      {(fetchState.status === 'idle' || fetchState.status === 'loading') && (
        <div
          role="status"
          aria-label="Loading organizations"
          className="flex items-center gap-2 py-4 text-sm"
        >
          <span className="loading loading-spinner loading-sm" aria-hidden="true" />
          Loading organizations…
        </div>
      )}

      {fetchState.status === 'error' && (
        <div className="flex items-center gap-2 py-4 text-sm text-base-content/60">
          <span>Could not load organizations.</span>
          <button onClick={() => loadOrgs(query)} className="btn btn-xs btn-ghost">Retry</button>
        </div>
      )}

      {fetchState.status === 'success' && fetchState.orgs.length === 0 && (
        <div className="text-base-content/60 py-4 text-sm">
          {hasActiveSearch
            ? 'No organizations match your search. Try adjusting the filters.'
            : 'No organizations yet. Use the button above to create one.'}
        </div>
      )}

      {fetchState.status === 'success' && fetchState.orgs.length > 0 && (
        <>
          {/* Desktop / tablet: full table (md and above) */}
          <div className="hidden md:block overflow-x-auto rounded-box border border-base-300">
            <table className="table table-zebra w-full">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Name</th>
                  <th>Email Domain</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Last Modified</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {fetchState.orgs.map((org) => (
                  <tr
                    key={org.org_key}
                    onClick={() => onOrgClick?.(org)}
                    className={onOrgClick ? 'cursor-pointer hover:bg-base-200' : ''}
                    aria-label={onOrgClick ? `View environments for ${org.org_key}` : undefined}
                    role={onOrgClick ? 'button' : undefined}
                    tabIndex={onOrgClick ? 0 : undefined}
                    onKeyDown={onOrgClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOrgClick(org); } } : undefined}
                  >
                    <td>
                      <span className="font-mono font-medium">{org.org_key}</span>
                    </td>
                    <td>{org.org_long_name}</td>
                    <td>
                      <span className="font-mono text-sm">{org.org_email_domain || '—'}</span>
                    </td>
                    <td>
                      <span className={`badge badge-sm ${org.org_active ? 'badge-success' : 'badge-ghost'}`}>
                        {org.org_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="text-base-content/70 text-sm">{fmtDate(org.created_date)}</td>
                    <td className="text-base-content/70 text-sm">{fmtDate(org.mod_date)}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          className="btn btn-xs btn-ghost"
                          onClick={(e) => { e.stopPropagation(); setEditOrg(org); setEditModalOpen(true); }}
                          aria-label={`Edit ${org.org_key}`}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-xs btn-ghost text-error"
                          onClick={(e) => { e.stopPropagation(); setDeleteOrg(org); }}
                          aria-label={`Delete ${org.org_key}`}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: stacked cards (below md) */}
          <div className="flex flex-col gap-3 md:hidden">
            {fetchState.orgs.map((org) => (
              <div
                key={org.org_key}
                className={`card border border-base-300 bg-base-100 shadow-sm${onOrgClick ? ' cursor-pointer hover:shadow-md hover:border-primary transition-shadow' : ''}`}
                onClick={() => onOrgClick?.(org)}
                aria-label={onOrgClick ? `View environments for ${org.org_key}` : undefined}
                role={onOrgClick ? 'button' : undefined}
                tabIndex={onOrgClick ? 0 : undefined}
                onKeyDown={onOrgClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOrgClick(org); } } : undefined}
              >
                <div className="card-body p-4 gap-2">
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-semibold">{org.org_key}</span>
                    <span className={`badge badge-sm ${org.org_active ? 'badge-success' : 'badge-ghost'}`}>
                      {org.org_active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                  <p className="text-sm font-medium">{org.org_long_name}</p>
                  {org.org_email_domain && (
                    <p className="font-mono text-sm text-base-content/70">{org.org_email_domain}</p>
                  )}
                  <div className="text-xs text-base-content/60 space-y-0.5 mt-1">
                    <p>Created: {fmtDate(org.created_date)}</p>
                    <p>Modified: {fmtDate(org.mod_date)}</p>
                  </div>
                  <div className="flex gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="btn btn-xs btn-ghost"
                      onClick={(e) => { e.stopPropagation(); setEditOrg(org); setEditModalOpen(true); }}
                    >Edit</button>
                    <button
                      type="button"
                      className="btn btn-xs btn-ghost text-error"
                      onClick={(e) => { e.stopPropagation(); setDeleteOrg(org); }}
                    >Delete</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── Edit org modal ────────────────────────────────────────────────── */}
      <OrgEditModal
        org={editOrg}
        open={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        onSuccess={(updated) => {
          setEditModalOpen(false);
          setFetchState((prev) =>
            prev.status === 'success'
              ? { ...prev, orgs: prev.orgs.map((o) => o.org_key === updated.org_key ? updated : o) }
              : prev
          );
        }}
      />

      {toast && <Toast message={toast.message} type={toast.type} onClose={clearToast} />}

      <ConfirmDeleteModal
        open={deleteOrg !== null}
        title={`Delete organization "${deleteOrg?.org_key}"?`}
        message="This will permanently delete the organization and all its decommissioned environments. Active environments must be decommissioned first."
        confirmLabel="Delete"
        onClose={() => setDeleteOrg(null)}
        onConfirm={async () => {
          const res = await fetch(`/api/orgs/${encodeURIComponent(deleteOrg!.org_key)}`, { method: 'DELETE' });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error((body as { error?: string }).error ?? `Server error ${res.status}`);
          }
          setDeleteOrg(null);
          setFetchState((prev) =>
            prev.status === 'success'
              ? { ...prev, orgs: prev.orgs.filter((o) => o.org_key !== deleteOrg!.org_key) }
              : prev
          );
        }}
      />
    </div>
  );
}
