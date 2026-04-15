/**
 * Database row types — mirror the PostgreSQL schema defined in
 * src/db/migrations/001_initial_schema.sql
 *
 * These are plain TypeScript interfaces; no ORM magic.
 */

// ---------------------------------------------------------------------------
// customer_org
// ---------------------------------------------------------------------------
export interface CustomerOrg {
  org_key: string;
  org_long_name: string;
  org_active: boolean;
  org_email_domain: string;
  org_data: Record<string, unknown>;
  created_date: string; // ISO-8601 string from postgres
  mod_date: string;
}

// ---------------------------------------------------------------------------
// customer_env
// ---------------------------------------------------------------------------
export type DeployStatus =
  | 'pending'
  | 'provisioning'
  | 'deployed'
  | 'reconfiguring'
  | 'stopping'
  | 'failed'
  | 'stopped'
  | 'decommissioning'
  | 'decommissioned';

/**
 * Snapshot of the config fields that are tracked for drift detection.
 * Stored in customer_env.last_applied_config (JSONB) after each successful
 * provision or patch operation so the worker can compare on the next cycle.
 */
export interface AppliedConfig {
  image: string;
  replicas: number;
  memory_req: string;
  memory_limit: string;
  cpu_req: string;
  cpu_limit: string;
  env_vars: Record<string, string>;
}

export interface CustomerEnv {
  org_key: string;
  env_key: string;
  cluster_id: string;
  region_id: string;
  image: string;
  replicas: number;
  memory_req: string;
  memory_limit: string;
  cpu_req: string;
  cpu_limit: string;
  env_vars: Record<string, string>;
  deploy_status: DeployStatus;
  created_date: string;
  mod_date: string;
  last_deploy_date: string | null;
  stop_date: string | null;
  dcomm_date: string | null;
  last_applied_config: AppliedConfig | null;
  pending_delete?: boolean; // DEFAULT false in DB; omitted from older fixtures
}

/** Convenience: the k8s INSTANCE = org_key + '-' + env_key */
export function instanceName(env: Pick<CustomerEnv, 'org_key' | 'env_key'>): string {
  return `${env.org_key}-${env.env_key}`;
}

// ---------------------------------------------------------------------------
// deployment_log
// ---------------------------------------------------------------------------
export type LogAction = 'provision' | 'patch' | 'stop' | 'decommission';
export type LogStatus = 'success' | 'failed' | 'retrying';

export interface DeploymentLog {
  deployment_log_id: number;
  log_org_key: string;
  log_env_key: string;
  action: LogAction;
  status: LogStatus;
  error_detail: string | null;
  retry_count: number;
  created_date: string;
}

// ---------------------------------------------------------------------------
// worker_state
// ---------------------------------------------------------------------------
export interface WorkerState {
  id: 1;
  last_poll_timestamp: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Create/update input shapes (omit server-managed fields)
// ---------------------------------------------------------------------------
export type CreateCustomerOrg = Pick<
  CustomerOrg,
  'org_key' | 'org_long_name' | 'org_active' | 'org_email_domain'
> & { org_data?: Record<string, unknown> };

export type CreateCustomerEnv = Pick<
  CustomerEnv,
  | 'org_key'
  | 'env_key'
  | 'image'
> & Partial<
  Pick<
    CustomerEnv,
    | 'cluster_id'
    | 'region_id'
    | 'replicas'
    | 'memory_req'
    | 'memory_limit'
    | 'cpu_req'
    | 'cpu_limit'
    | 'env_vars'
    | 'stop_date'
  >
>;

export type CreateDeploymentLog = Pick<
  DeploymentLog,
  'log_org_key' | 'log_env_key' | 'action' | 'status'
> & {
  error_detail?: string | null;
  retry_count?: number;
};
