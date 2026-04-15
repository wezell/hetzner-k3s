'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { CustomerEnv, DeploymentLog } from '@/db/types';
import { StatusBadge } from '@/components/StatusBadge';
import { DeploymentLogPanel } from '@/components/DeploymentLogPanel';
import { DeploymentStatusPanel } from '@/components/DeploymentStatusPanel';
import DeploymentLogModal from '@/components/DeploymentLogModal';
import EnvVarsEditor from '@/components/EnvVarsEditor';
import AppSidebar from '@/components/AppSidebar';
import {
  buildEnvsViewUrl,
  buildOrgEnvsUrl,
  buildOrgsViewUrl,
  buildBreadcrumbTrail,
} from '@/lib/navLinks';
import {
  buildDetailFetchUrl,
  buildStatusFetchUrl,
  buildStopUrl,
  buildDecommissionUrl,
  buildSettingsPatchUrl,
} from '@/lib/envDetailApi';
import {
  envToFormState,
  validateSettingsForm,
  isSettingsDirty as computeIsSettingsDirty,
  type SettingsFormState,
} from '@/lib/settingsForm';
import { formatDate, formatRelativeTime } from '@/lib/dateFormat';
import { useToast } from '@/hooks/useToast';
import Toast from '@/components/Toast';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StatusResponse {
  org_key: string;
  env_key: string;
  deploy_status: CustomerEnv['deploy_status'];
  last_deploy_date: string | null;
  stop_date: string | null;
  dcomm_date: string | null;
  mod_date: string;
  current_retry_count: number;
  logs: DeploymentLog[];
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <tr>
      <td className="py-2 pr-4 text-sm font-medium text-base-content/60 align-top whitespace-nowrap">
        {label}
      </td>
      <td className="py-2 text-sm text-base-content align-top break-all">
        {value}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function EnvDetailPage() {
  const params = useParams<{ org: string; env: string }>();
  const { org: orgKey, env: envKey } = params;

  const [envData, setEnvData] = useState<CustomerEnv | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [lastPolledAt, setLastPolledAt] = useState<string | null>(null);
  const [isPollingStatus, setIsPollingStatus] = useState(false);
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);

  // Action states
  const [showStopModal, setShowStopModal] = useState(false);
  const [showDecommissionModal, setShowDecommissionModal] = useState(false);
  const [showLogModal, setShowLogModal] = useState(false);
  const [showManifestModal, setShowManifestModal] = useState(false);
  const [manifestYaml, setManifestYaml] = useState<string | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [decommissioning, setDecommissioning] = useState(false);

  // Settings form state
  const [settingsForm, setSettingsForm] = useState<SettingsFormState | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const { toast, showToast, clearToast } = useToast();
  // Key-value editor state for env_vars — kept in sync with settingsForm.env_vars_raw
  const [envVarsMap, setEnvVarsMap] = useState<Record<string, string>>({});

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Fetch full env config ─────────────────────────────────────────────────

  const loadEnvData = useCallback(async () => {
    try {
      const res = await fetch(
        buildDetailFetchUrl(orgKey, envKey)
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setLoadError(
          (body as { error?: string }).error ??
            `Server error ${res.status}`
        );
        setLoadState('error');
        return;
      }
      const data: CustomerEnv = await res.json();
      setEnvData(data);
      setSettingsForm(envToFormState(data));
      setEnvVarsMap(data.env_vars ?? {});
    } catch {
      setLoadError('Network error. Could not load environment details.');
      setLoadState('error');
    }
  }, [orgKey, envKey]);

  // ── Poll live status ──────────────────────────────────────────────────────

  const fetchStatus = useCallback(async () => {
    setIsPollingStatus(true);
    try {
      const res = await fetch(
        buildStatusFetchUrl(orgKey, envKey)
      );
      if (!res.ok) return;
      const data: StatusResponse = await res.json();
      setStatus(data);
      setLastPolledAt(new Date().toISOString());
    } catch {
      // Silently swallow poll errors
    } finally {
      setIsPollingStatus(false);
    }
  }, [orgKey, envKey]);

  // ── Initial load ──────────────────────────────────────────────────────────

  useEffect(() => {
    async function init() {
      setLoadState('loading');
      await loadEnvData();
      await fetchStatus();
      setLoadState('ready');
    }
    void init();
  }, [loadEnvData, fetchStatus]);

  // ── Start polling status once ready ──────────────────────────────────────

  useEffect(() => {
    if (loadState !== 'ready') return;
    pollTimerRef.current = setInterval(fetchStatus, 5_000);
    return () => {
      if (pollTimerRef.current !== null) clearInterval(pollTimerRef.current);
    };
  }, [loadState, fetchStatus]);

  // ── Stop action ───────────────────────────────────────────────────────────

  const handleStop = useCallback(async () => {
    setStopping(true);
    try {
      const res = await fetch(buildStopUrl(orgKey, envKey), { method: 'PATCH' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        showToast(
          (body as { detail?: string; error?: string }).detail ??
            (body as { error?: string }).error ??
            `Server error ${res.status}`,
          'error'
        );
      } else {
        // Apply the returned row so replicas=0 and stop_date are immediately visible.
        const updated = await res.json().catch(() => null);
        if (updated) {
          setEnvData(updated);
          setSettingsForm(envToFormState(updated));
          setEnvVarsMap(updated.env_vars ?? {});
        }
        await fetchStatus();
        setShowStopModal(false);
        showToast('Environment stop scheduled — scaling to 0 replicas.', 'info');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Network error', 'error');
    } finally {
      setStopping(false);
    }
  }, [orgKey, envKey, fetchStatus, showToast]);

  // ── Decommission action ───────────────────────────────────────────────────

  const handleDecommission = useCallback(async () => {
    setDecommissioning(true);
    try {
      const res = await fetch(buildDecommissionUrl(orgKey, envKey), { method: 'PATCH' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        showToast(
          (body as { detail?: string; error?: string }).detail ??
            (body as { error?: string }).error ??
            `Server error ${res.status}`,
          'error'
        );
      } else {
        setShowDecommissionModal(false);
        await fetchStatus();
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Network error', 'error');
    } finally {
      setDecommissioning(false);
    }
  }, [orgKey, envKey, fetchStatus]);

  // ── Settings save ─────────────────────────────────────────────────────────

  const handleSettingsSave = useCallback(async () => {
    if (!settingsForm || !envData) return;

    // Validate form inputs via shared pure utility (also tested in settingsForm.test.ts)
    const validationResult = validateSettingsForm(settingsForm);
    if (!validationResult.valid) {
      showToast(validationResult.error, 'error');
      return;
    }
    const { replicas: replicasNum, env_vars: parsedEnvVars, ...rest } = validationResult.data;

    setSettingsSaving(true);

    // Optimistic update: immediately reflect changes in the display cards
    // so the user sees instant feedback while the PATCH is in flight.
    const previousEnvData = envData;
    const optimisticEnv: CustomerEnv = {
      ...envData,
      image: rest.image || envData.image,
      replicas: replicasNum,
      memory_req: rest.memory_req || envData.memory_req,
      memory_limit: rest.memory_limit || envData.memory_limit,
      cpu_req: rest.cpu_req || envData.cpu_req,
      cpu_limit: rest.cpu_limit || envData.cpu_limit,
      env_vars: parsedEnvVars,
    };
    setEnvData(optimisticEnv);

    try {
      const res = await fetch(
        buildSettingsPatchUrl(orgKey, envKey),
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validationResult.data),
        }
      );

      if (!res.ok) {
        // Revert optimistic update on server error
        setEnvData(previousEnvData);
        const body = await res.json().catch(() => ({}));
        showToast((body as { error?: string }).error ?? `Server error ${res.status}`, 'error');
        return;
      }

      // Confirm with the authoritative server response
      const updated: CustomerEnv = await res.json();
      setEnvData(updated);
      setSettingsForm(envToFormState(updated));
      setEnvVarsMap(updated.env_vars ?? {});
      showToast('Settings saved successfully', 'success');
    } catch (err) {
      // Revert optimistic update on network error
      setEnvData(previousEnvData);
      showToast(err instanceof Error ? err.message : 'Network error', 'error');
    } finally {
      setSettingsSaving(false);
    }
  }, [settingsForm, envData, orgKey, envKey]);

  const handleSettingsReset = useCallback(() => {
    if (!envData) return;
    setSettingsForm(envToFormState(envData));
    setEnvVarsMap(envData.env_vars ?? {});
    clearToast();
  }, [envData]);

  // ── Dirty detection ───────────────────────────────────────────────────────

  const isSettingsDirty =
    settingsForm !== null &&
    envData !== null &&
    computeIsSettingsDirty(settingsForm, envData);

  // ── Derive display values ─────────────────────────────────────────────────

  const deployStatus = status?.deploy_status ?? envData?.deploy_status;
  const canStop = deployStatus === 'deployed';
  const canDecommission = deployStatus === 'stopped' || deployStatus === 'failed';

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
    <div className="drawer lg:drawer-open min-h-screen">
      {/* Hidden checkbox for mobile drawer */}
      <input id="detail-drawer" type="checkbox" className="drawer-toggle" />

      {/* ── Main content ─────────────────────────────────────────────────── */}
      <div className="drawer-content flex flex-col">
        {/* Top navbar */}
        <header className="navbar bg-base-100 border-b border-base-300 sticky top-0 z-10 shadow-sm">
          {/* Hamburger — mobile only */}
          <div className="flex-none lg:hidden">
            <label
              htmlFor="detail-drawer"
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

          <div className="flex-1 px-2">
            <span className="text-base font-semibold">dotCMS Control Plane</span>
            <span className="hidden sm:inline text-sm text-base-content/60 ml-2">
              Kubernetes tenant provisioning &amp; lifecycle management
            </span>
          </div>
        </header>

        {/* ── Page body ──────────────────────────────────────────────────── */}
        <main className="flex-1 p-4 md:p-6 max-w-5xl mx-auto w-full">
          {/* Breadcrumb */}
          <nav className="text-sm breadcrumbs mb-4" aria-label="Breadcrumb">
            <ul>
              <li>
                <Link href={buildEnvsViewUrl()} className="link link-hover">
                  Environments
                </Link>
              </li>
              <li>
                <Link
                  href={buildOrgEnvsUrl(orgKey)}
                  className="link link-hover"
                >
                  {orgKey}
                </Link>
              </li>
              <li className="font-semibold">{envKey}</li>
            </ul>
          </nav>

          {/* Loading state */}
          {loadState === 'loading' && (
            <div
              role="status"
              aria-label="Loading environment details"
              className="flex items-center gap-2 py-8 text-sm"
            >
              <span
                className="loading loading-spinner loading-sm"
                aria-hidden="true"
              />
              Loading environment details…
            </div>
          )}

          {/* Error state */}
          {loadState === 'error' && (
            <div className="space-y-4">
              <p className="text-sm text-base-content/60">{loadError}</p>
              <Link href={buildOrgEnvsUrl(orgKey)} className="btn btn-ghost btn-sm">
                ← Back to environments
              </Link>
            </div>
          )}

          {/* Loaded state */}
          {loadState === 'ready' && envData && (
            <div className="space-y-6">
              {/* ── Header ────────────────────────────────────────────────── */}
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="flex-1 min-w-0">
                  <h1 className="text-2xl font-bold font-mono truncate">
                    {envKey}
                  </h1>
                  <p className="text-sm text-base-content/60 mt-0.5">
                    Organization:{' '}
                    <Link
                      href={buildOrgEnvsUrl(orgKey)}
                      className="link link-hover font-mono"
                    >
                      {orgKey}
                    </Link>
                  </p>
                  <p className="text-sm text-base-content/60 mt-0.5">
                    
                    <Link
                      href={`https://${orgKey}-${envKey}.botcms.cloud/dotAdmin`}
                      className="link link-hover"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {`https://${orgKey}-${envKey}.botcms.cloud/dotAdmin`}
                    </Link>
                  </p>


                </div>

                {/* Status badge — compact header indicator */}
                {deployStatus && (
                  <div className="shrink-0">
                    <StatusBadge status={deployStatus} />
                  </div>
                )}
              </div>

              {/* ── Deployment status panel ───────────────────────────────── */}
              <DeploymentStatusPanel
                deployStatus={deployStatus}
                retryCount={status?.current_retry_count}
                lastDeployDate={status?.last_deploy_date ?? envData.last_deploy_date}
                lastPolledAt={lastPolledAt}
                isPolling={isPollingStatus}
              />

              {/* ── Action buttons ────────────────────────────────────────── */}
              <div className="flex flex-wrap gap-2">
                {/* Stop */}
                {(canStop || stopping) && (
                  <div className="flex flex-col gap-1">
                    <button
                      type="button"
                      disabled={stopping}
                      onClick={() => setShowStopModal(true)}
                      className="btn btn-sm btn-warning"
                      title="Scale this environment to 0 replicas"
                    >
                      {stopping ? (
                        <>
                          <span
                            className="loading loading-spinner loading-xs"
                            aria-hidden="true"
                          />
                          Stopping…
                        </>
                      ) : (
                        'Stop'
                      )}
                    </button>
                  </div>
                )}

                {/* Decommission */}
                {(canDecommission || decommissioning) && (
                  <div className="flex flex-col gap-1">
                    <button
                      type="button"
                      disabled={decommissioning}
                      onClick={() => setShowDecommissionModal(true)}
                      className="btn btn-sm btn-error"
                      title="Permanently tear down this environment (irreversible)"
                    >
                      {decommissioning ? (
                        <>
                          <span
                            className="loading loading-spinner loading-xs"
                            aria-hidden="true"
                          />
                          Scheduling…
                        </>
                      ) : (
                        'Decommission'
                      )}
                    </button>
                  </div>
                )}

                {/* View Latest Log */}
                <button
                  type="button"
                  onClick={() => setShowLogModal(true)}
                  className="btn btn-sm btn-outline"
                  title="View the latest deployment log entry in a modal"
                >
                  View Latest Log
                </button>

                {/* View Manifest */}
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  title="Preview the generated kustomize manifest for this environment"
                  onClick={async () => {
                    setManifestYaml(null);
                    setShowManifestModal(true);
                    setManifestLoading(true);
                    try {
                      const res = await fetch(
                        `/api/envs/${encodeURIComponent(orgKey)}/manifest?env_key=${encodeURIComponent(envKey)}`
                      );
                      const text = await res.text();
                      setManifestYaml(res.ok ? text : `Error ${res.status}: ${text}`);
                    } catch (err) {
                      setManifestYaml(err instanceof Error ? err.message : 'Failed to load manifest');
                    } finally {
                      setManifestLoading(false);
                    }
                  }}
                >
                  View Manifest
                </button>
              </div>

              {/* ── Cards grid ───────────────────────────────────────────── */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Config card */}
                <div className="card bg-base-100 border border-base-300 shadow-sm">
                  <div className="card-body p-4">
                    <h2 className="card-title text-base mb-2">Configuration</h2>
                    <table className="w-full">
                      <tbody>
                        <InfoRow
                          label="Image"
                          value={
                            <span className="font-mono text-xs break-all">
                              {envData.image}
                            </span>
                          }
                        />
                        <InfoRow
                          label="Replicas"
                          value={envData.replicas}
                        />
                        <InfoRow
                          label="Cluster"
                          value={
                            <span className="font-mono text-xs">
                              {envData.cluster_id}
                            </span>
                          }
                        />
                        <InfoRow
                          label="Region"
                          value={
                            <span className="font-mono text-xs">
                              {envData.region_id}
                            </span>
                          }
                        />
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Resources card */}
                <div className="card bg-base-100 border border-base-300 shadow-sm">
                  <div className="card-body p-4">
                    <h2 className="card-title text-base mb-2">Resources</h2>
                    <table className="w-full">
                      <tbody>
                        <InfoRow
                          label="Memory request"
                          value={
                            <span className="font-mono text-xs">
                              {envData.memory_req}
                            </span>
                          }
                        />
                        <InfoRow
                          label="Memory limit"
                          value={
                            <span className="font-mono text-xs">
                              {envData.memory_limit}
                            </span>
                          }
                        />
                        <InfoRow
                          label="CPU request"
                          value={
                            <span className="font-mono text-xs">
                              {envData.cpu_req}
                            </span>
                          }
                        />
                        <InfoRow
                          label="CPU limit"
                          value={
                            <span className="font-mono text-xs">
                              {envData.cpu_limit}
                            </span>
                          }
                        />
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Lifecycle card */}
                <div className="card bg-base-100 border border-base-300 shadow-sm">
                  <div className="card-body p-4">
                    <h2 className="card-title text-base mb-2">Lifecycle</h2>
                    <table className="w-full">
                      <tbody>
                        <InfoRow
                          label="Created"
                          value={
                            <span title={formatDate(envData.created_date)}>
                              {formatRelativeTime(envData.created_date)}
                            </span>
                          }
                        />
                        <InfoRow
                          label="Modified"
                          value={
                            <span
                              title={formatDate(
                                status?.mod_date ?? envData.mod_date
                              )}
                            >
                              {formatRelativeTime(
                                status?.mod_date ?? envData.mod_date
                              )}
                            </span>
                          }
                        />
                        <InfoRow
                          label="Last deployed"
                          value={
                            <span
                              title={formatDate(
                                status?.last_deploy_date ?? envData.last_deploy_date
                              )}
                            >
                              {formatRelativeTime(
                                status?.last_deploy_date ?? envData.last_deploy_date
                              )}
                            </span>
                          }
                        />
                        <InfoRow
                          label="Stop scheduled"
                          value={
                            (status?.stop_date ?? envData.stop_date) ? (
                              <span
                                title={formatDate(status?.stop_date ?? envData.stop_date)}
                                className="text-warning"
                              >
                                {formatRelativeTime(status?.stop_date ?? envData.stop_date)}
                              </span>
                            ) : <span className="text-base-content/40">—</span>
                          }
                        />
                        <InfoRow
                          label="Decommission scheduled"
                          value={
                            (status?.dcomm_date ?? envData.dcomm_date) ? (
                              <span
                                title={formatDate(status?.dcomm_date ?? envData.dcomm_date)}
                                className="text-error"
                              >
                                {formatRelativeTime(status?.dcomm_date ?? envData.dcomm_date)}
                              </span>
                            ) : <span className="text-base-content/40">—</span>
                          }
                        />
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Env vars card */}
                {envData.env_vars &&
                  Object.keys(envData.env_vars).length > 0 && (
                    <div className="card bg-base-100 border border-base-300 shadow-sm">
                      <div className="card-body p-4">
                        <h2 className="card-title text-base mb-2">
                          Environment Variables
                        </h2>
                        <div className="overflow-x-auto">
                          <table className="table table-xs w-full">
                            <thead>
                              <tr>
                                <th>Key</th>
                                <th>Value</th>
                              </tr>
                            </thead>
                            <tbody>
                              {Object.entries(envData.env_vars).map(
                                ([k, v]) => (
                                  <tr key={k}>
                                    <td className="font-mono">{k}</td>
                                    <td className="font-mono break-all">
                                      {v}
                                    </td>
                                  </tr>
                                )
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  )}
              </div>

              {/* ── Settings form ─────────────────────────────────────────── */}
              {settingsForm && (
                <div className="card bg-base-100 border border-base-300 shadow-sm">
                  <div className="card-body p-5 gap-5">
                    {/* Header */}
                    <div className="flex items-center justify-between">
                      <h2 className="card-title text-base">Settings</h2>
                      {isSettingsDirty && (
                        <span className="badge badge-warning badge-sm">Unsaved changes</span>
                      )}
                    </div>

                    {/* Identity row — read-only badges */}
                    <div className="flex flex-wrap gap-3 text-sm">
                      <span className="text-base-content/50">Org:</span>
                      <span className="font-mono font-medium">{orgKey}</span>
                      <span className="text-base-content/30">·</span>
                      <span className="text-base-content/50">Env:</span>
                      <span className="font-mono font-medium">{envKey}</span>
                    </div>

                    {/* Image — full width */}
                    <fieldset className="fieldset">
                      <legend className="fieldset-legend">Docker Image</legend>
                      <input
                        type="text"
                        value={settingsForm.image}
                        onChange={(e) => setSettingsForm((f) => f ? { ...f, image: e.target.value } : f)}
                        placeholder="e.g. mirror.gcr.io/dotcms/dotcms:latest"
                        className="input input-sm font-mono w-full"
                        disabled={settingsSaving}
                      />
                    </fieldset>

                    {/* Replicas + Resources grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      <fieldset className="fieldset">
                        <legend className="fieldset-legend">Replicas</legend>
                        <input
                          type="number"
                          min={0}
                          value={settingsForm.replicas}
                          onChange={(e) => setSettingsForm((f) => f ? { ...f, replicas: e.target.value } : f)}
                          className="input input-sm w-full"
                          disabled={settingsSaving}
                        />
                      </fieldset>
                      <fieldset className="fieldset">
                        <legend className="fieldset-legend">Memory Request</legend>
                        <input
                          type="text"
                          value={settingsForm.memory_req}
                          onChange={(e) => setSettingsForm((f) => f ? { ...f, memory_req: e.target.value } : f)}
                          placeholder="4Gi"
                          className="input input-sm font-mono w-full"
                          disabled={settingsSaving}
                        />
                      </fieldset>
                      <fieldset className="fieldset">
                        <legend className="fieldset-legend">Memory Limit</legend>
                        <input
                          type="text"
                          value={settingsForm.memory_limit}
                          onChange={(e) => setSettingsForm((f) => f ? { ...f, memory_limit: e.target.value } : f)}
                          placeholder="5Gi"
                          className="input input-sm font-mono w-full"
                          disabled={settingsSaving}
                        />
                      </fieldset>
                      <fieldset className="fieldset">
                        <legend className="fieldset-legend">CPU Request</legend>
                        <input
                          type="text"
                          value={settingsForm.cpu_req}
                          onChange={(e) => setSettingsForm((f) => f ? { ...f, cpu_req: e.target.value } : f)}
                          placeholder="500m"
                          className="input input-sm font-mono w-full"
                          disabled={settingsSaving}
                        />
                      </fieldset>
                      <fieldset className="fieldset">
                        <legend className="fieldset-legend">CPU Limit</legend>
                        <input
                          type="text"
                          value={settingsForm.cpu_limit}
                          onChange={(e) => setSettingsForm((f) => f ? { ...f, cpu_limit: e.target.value } : f)}
                          placeholder="2000m"
                          className="input input-sm font-mono w-full"
                          disabled={settingsSaving}
                        />
                      </fieldset>
                    </div>

                    {/* Environment Variables — key/value editor */}
                    <fieldset className="fieldset">
                      <legend className="fieldset-legend">
                        Environment Variables
                        <span className="text-base-content/50 font-normal text-xs ml-1">Optional</span>
                      </legend>
                      <EnvVarsEditor
                        value={envVarsMap}
                        disabled={settingsSaving}
                        onChange={(vars) => {
                          setEnvVarsMap(vars);
                          setSettingsForm((f) =>
                            f ? { ...f, env_vars_raw: JSON.stringify(vars) } : f
                          );
                        }}
                      />
                    </fieldset>

                    {/* Schedule dates */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <fieldset className="fieldset">
                        <legend className="fieldset-legend">
                          Stop date
                          <span className="text-base-content/50 font-normal text-xs ml-1">Optional</span>
                        </legend>
                        <input
                          type="date"
                          value={settingsForm.stop_date ?? ''}
                          onChange={(e) => setSettingsForm((f) => f ? { ...f, stop_date: e.target.value } : f)}
                          className="input input-sm w-full"
                          disabled={settingsSaving}
                        />
                        {settingsForm.stop_date && (
                          <button
                            type="button"
                            className="btn btn-xs btn-ghost text-error self-start"
                            onClick={() => setSettingsForm((f) => f ? { ...f, stop_date: '' } : f)}
                            disabled={settingsSaving}
                          >✕ Clear</button>
                        )}
                      </fieldset>
                      <fieldset className="fieldset">
                        <legend className="fieldset-legend">
                          Decommission date
                          <span className="text-base-content/50 font-normal text-xs ml-1">Optional</span>
                        </legend>
                        <input
                          type="date"
                          value={settingsForm.dcomm_date ?? ''}
                          onChange={(e) => setSettingsForm((f) => f ? { ...f, dcomm_date: e.target.value } : f)}
                          className="input input-sm w-full"
                          disabled={settingsSaving}
                        />
                        {settingsForm.dcomm_date && (
                          <button
                            type="button"
                            className="btn btn-xs btn-ghost text-error self-start"
                            onClick={() => setSettingsForm((f) => f ? { ...f, dcomm_date: '' } : f)}
                            disabled={settingsSaving}
                          >✕ Clear</button>
                        )}
                      </fieldset>
                    </div>

                    {/* Action row */}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={settingsSaving || !isSettingsDirty}
                        onClick={handleSettingsSave}
                        className="btn btn-sm btn-primary"
                      >
                        {settingsSaving && <span className="loading loading-spinner loading-xs" />}
                        {settingsSaving ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        type="button"
                        disabled={settingsSaving || !isSettingsDirty}
                        onClick={handleSettingsReset}
                        className="btn btn-sm btn-ghost"
                      >
                        Reset
                      </button>
                    </div>
                  </div>
                </div>
              )}

                            {/* ── Deployment logs ───────────────────────────────────────── */}
              <div className="card bg-base-100 border border-base-300 shadow-sm">
                <div className="card-body p-4">
                  <h2 className="card-title text-base mb-2">Deployment Logs</h2>
                  <DeploymentLogPanel
                    org_key={orgKey}
                    env_key={envKey}
                    limit={50}
                    className="shadow-none border-0"
                  />
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* ── Deployment log modal ─────────────────────────────────────────────── */}
      <DeploymentLogModal
        open={showLogModal}
        onClose={() => setShowLogModal(false)}
        org_key={orgKey}
        env_key={envKey}
      />

      {/* ── Manifest preview modal ───────────────────────────────────────── */}
      {showManifestModal && (
        <dialog className="modal" open aria-labelledby="manifest-modal-title">
          <div className="modal-box w-11/12 max-w-4xl overflow-hidden flex flex-col max-h-[80vh]">
            <div className="flex items-center justify-between mb-4 shrink-0">
              <h3 id="manifest-modal-title" className="font-bold text-lg">
                Manifest — <span className="font-mono text-base">{orgKey}/{envKey}</span>
              </h3>
              <button
                type="button"
                className="btn btn-sm btn-circle btn-ghost"
                onClick={() => setShowManifestModal(false)}
                aria-label="Close"
              >✕</button>
            </div>
            {manifestLoading ? (
              <div className="flex items-center gap-2 py-8 justify-center">
                <span className="loading loading-spinner loading-md" />
                <span className="text-sm text-base-content/60">Generating manifest…</span>
              </div>
            ) : (
              <pre className="overflow-auto flex-1 bg-base-200 rounded-box p-4 text-xs font-mono whitespace-pre">
                {manifestYaml}
              </pre>
            )}
            <div className="modal-action shrink-0 mt-4">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  if (manifestYaml) navigator.clipboard.writeText(manifestYaml);
                }}
                disabled={!manifestYaml || manifestLoading}
              >
                Copy
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setShowManifestModal(false)}>
                Close
              </button>
            </div>
          </div>
          <div className="modal-backdrop" onClick={() => setShowManifestModal(false)} />
        </dialog>
      )}

      {/* ── Stop confirmation modal ───────────────────────────────────────── */}
      <dialog
        id="stop-confirm-modal"
        className="modal"
        open={showStopModal}
        aria-labelledby="stop-modal-title"
      >
        <div className="modal-box overflow-hidden">
          <h3 id="stop-modal-title" className="font-bold text-lg mb-1">
            Stop Environment
          </h3>
          <p className="text-sm text-base-content/70 mb-4">
            Stop{' '}
            <span className="font-mono font-semibold">
              {orgKey}/{envKey}
            </span>
            ?
          </p>
          <p className="text-sm mb-4">
            This will schedule the environment to scale to{' '}
            <strong>0 replicas</strong>. The environment can be redeployed
            at any time — this action is reversible.
          </p>

          <div className="modal-action">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={stopping}
              onClick={() => setShowStopModal(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-warning btn-sm"
              disabled={stopping}
              onClick={handleStop}
            >
              {stopping ? (
                <>
                  <span
                    className="loading loading-spinner loading-xs"
                    aria-hidden="true"
                  />
                  Stopping…
                </>
              ) : (
                'Stop Environment'
              )}
            </button>
          </div>
        </div>
        {/* Backdrop — click outside to cancel */}
        <form method="dialog" className="modal-backdrop">
          <button
            type="submit"
            onClick={() => setShowStopModal(false)}
            aria-label="Close modal"
          >
            close
          </button>
        </form>
      </dialog>

      {/* ── Decommission confirmation modal ───────────────────────────────── */}
      <dialog
        id="decommission-confirm-modal"
        className="modal"
        open={showDecommissionModal}
        aria-labelledby="decommission-modal-title"
      >
        <div className="modal-box overflow-hidden">
          <h3 id="decommission-modal-title" className="font-bold text-lg mb-1">
            Decommission Environment
          </h3>
          <p className="text-sm text-base-content/70 mb-4">
            Permanently decommission{' '}
            <span className="font-mono font-semibold">
              {orgKey}/{envKey}
            </span>
            ?
          </p>
          <p className="text-sm mb-4">
            This will schedule the environment for <strong>full teardown</strong> —
            the Kubernetes namespace, database, S3 bucket, and all associated
            resources will be permanently deleted.{' '}
            <strong className="text-error">This action cannot be undone.</strong>
          </p>

          <div className="modal-action">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={decommissioning}
              onClick={() => setShowDecommissionModal(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-error btn-sm"
              disabled={decommissioning}
              onClick={handleDecommission}
            >
              {decommissioning ? (
                <>
                  <span
                    className="loading loading-spinner loading-xs"
                    aria-hidden="true"
                  />
                  Scheduling…
                </>
              ) : (
                'Decommission Environment'
              )}
            </button>
          </div>
        </div>
        {/* Backdrop — click outside to cancel */}
        <form method="dialog" className="modal-backdrop">
          <button
            type="submit"
            onClick={() => setShowDecommissionModal(false)}
            aria-label="Close modal"
          >
            close
          </button>
        </form>
      </dialog>

      {/* ── Sidebar (drawer side) ─────────────────────────────────────────── */}
      <div className="drawer-side z-20">
        <label
          htmlFor="detail-drawer"
          aria-label="Close sidebar menu"
          className="drawer-overlay"
        />
        <AppSidebar activeView="envs" />
      </div>
    </div>
    {toast && <Toast message={toast.message} type={toast.type} onClose={clearToast} />}
    </>
  );
}
