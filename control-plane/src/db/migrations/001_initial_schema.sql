-- Migration: 001_initial_schema
-- Description: Create customer_org, customer_env, deployment_log, and worker_state tables
-- for dotCMS Kubernetes tenant provisioning lifecycle management.

-- ---------------------------------------------------------------------------
-- customer_org — one record per customer organization
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_org (
  org_key          TEXT        PRIMARY KEY,
  org_long_name    TEXT        NOT NULL,
  org_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  org_email_domain TEXT        NOT NULL,
  org_data         JSONB       NOT NULL DEFAULT '{}',
  created_date     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mod_date         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  customer_org IS 'Top-level customer organization records.';
COMMENT ON COLUMN customer_org.org_key          IS 'Primary key — short slug, e.g. acme, my-corp. Becomes TENANT_ID in k8s namespace.';
COMMENT ON COLUMN customer_org.org_long_name    IS 'Human-readable organization display name.';
COMMENT ON COLUMN customer_org.org_active       IS 'Whether the organization is currently active.';
COMMENT ON COLUMN customer_org.org_email_domain IS 'Email domain associated with the organization, e.g. acme.com.';
COMMENT ON COLUMN customer_org.org_data         IS 'Extensible JSONB metadata for the organization.';
COMMENT ON COLUMN customer_org.created_date     IS 'Timestamp when the org record was created.';
COMMENT ON COLUMN customer_org.mod_date         IS 'Timestamp of last modification.';

-- ---------------------------------------------------------------------------
-- customer_env — one record per tenant environment (org_key + env_key = instance)
-- ---------------------------------------------------------------------------
-- deploy_status values:
--   pending        — created, waiting for worker to pick up
--   provisioning   — worker is actively provisioning k8s resources
--   deployed       — all resources provisioned, dotCMS pod Ready
--   failed         — provisioning failed after max retries
--   stopped        — scaled to 0 replicas (stop_date set)
--   decommissioned — all resources removed (dcomm_date set + teardown complete)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_env (
  org_key          TEXT        NOT NULL REFERENCES customer_org(org_key),
  env_key          TEXT        NOT NULL,

  -- Cluster / region (reserved for future multi-cluster)
  cluster_id       TEXT        NOT NULL DEFAULT 'default',
  region_id        TEXT        NOT NULL DEFAULT 'ash',

  -- dotCMS container image
  image            TEXT        NOT NULL,

  -- Kubernetes resource sizing
  replicas         INTEGER     NOT NULL DEFAULT 1,
  memory_req       TEXT        NOT NULL DEFAULT '4Gi',
  memory_limit     TEXT        NOT NULL DEFAULT '5Gi',
  cpu_req          TEXT        NOT NULL DEFAULT '500m',
  cpu_limit        TEXT        NOT NULL DEFAULT '2000m',

  -- Per-environment variables injected into dotCMS pods
  env_vars         JSONB       NOT NULL DEFAULT '{}',

  -- Lifecycle state
  deploy_status    TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (deploy_status IN (
                                 'pending','provisioning','deployed',
                                 'failed','stopped','decommissioned'
                               )),

  -- Timestamps
  created_date     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mod_date         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_deploy_date TIMESTAMPTZ,
  stop_date        TIMESTAMPTZ,
  dcomm_date       TIMESTAMPTZ,

  PRIMARY KEY (org_key, env_key)
);

COMMENT ON TABLE  customer_env IS 'One row per tenant environment. org_key+env_key maps to TENANT_ID-ENV_ID in k8s.';
COMMENT ON COLUMN customer_env.org_key          IS 'FK to customer_org. Becomes k8s TENANT_ID (namespace).';
COMMENT ON COLUMN customer_env.env_key          IS 'Environment slug (e.g. prod, staging). Becomes ENV_ID.';
COMMENT ON COLUMN customer_env.cluster_id       IS 'Target cluster identifier. Reserved for future multi-cluster use.';
COMMENT ON COLUMN customer_env.region_id        IS 'Target region identifier. Reserved for future use.';
COMMENT ON COLUMN customer_env.image            IS 'Fully-qualified dotCMS container image reference, e.g. mirror.gcr.io/dotcms/dotcms:LTS-24.10.';
COMMENT ON COLUMN customer_env.replicas         IS 'Desired dotCMS replica count.';
COMMENT ON COLUMN customer_env.memory_req       IS 'Kubernetes memory request for dotCMS pods, e.g. 4Gi.';
COMMENT ON COLUMN customer_env.memory_limit     IS 'Kubernetes memory limit for dotCMS pods, e.g. 5Gi.';
COMMENT ON COLUMN customer_env.cpu_req          IS 'Kubernetes CPU request in millicores, e.g. 500m.';
COMMENT ON COLUMN customer_env.cpu_limit        IS 'Kubernetes CPU limit in millicores, e.g. 2000m.';
COMMENT ON COLUMN customer_env.env_vars         IS 'JSONB map of environment-specific variables injected into dotCMS pods.';
COMMENT ON COLUMN customer_env.deploy_status    IS 'Current deployment state: pending | provisioning | deployed | failed | stopped | decommissioned.';
COMMENT ON COLUMN customer_env.created_date     IS 'Timestamp when this environment record was created.';
COMMENT ON COLUMN customer_env.mod_date         IS 'Timestamp of last modification — polled by worker to detect changes.';
COMMENT ON COLUMN customer_env.last_deploy_date IS 'Timestamp of last successful deployment (pod reached Ready).';
COMMENT ON COLUMN customer_env.stop_date        IS 'When set, worker scales deployment to 0 replicas preserving all data.';
COMMENT ON COLUMN customer_env.dcomm_date       IS 'When set, worker performs full teardown (DB drop, OpenSearch cleanup, namespace deletion).';

-- Index for worker polling: find environments modified since last poll
CREATE INDEX IF NOT EXISTS idx_customer_env_mod_date
  ON customer_env(mod_date);

-- Index for status-based dashboard queries
CREATE INDEX IF NOT EXISTS idx_customer_env_deploy_status
  ON customer_env(deploy_status);

-- ---------------------------------------------------------------------------
-- deployment_log — audit log of all provisioning operations
-- ---------------------------------------------------------------------------
-- action values:  provision | patch | stop | decommission
-- status values:  success | failed | retrying
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deployment_log (
  deployment_log_id BIGSERIAL   PRIMARY KEY,
  log_org_key       TEXT        NOT NULL REFERENCES customer_org(org_key),
  log_env_key       TEXT        NOT NULL,

  action            TEXT        NOT NULL
                                CHECK (action IN ('provision','patch','stop','decommission')),
  status            TEXT        NOT NULL
                                CHECK (status IN ('success','failed','retrying')),
  error_detail      TEXT,
  retry_count       INTEGER     NOT NULL DEFAULT 0,
  created_date      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  FOREIGN KEY (log_org_key, log_env_key)
    REFERENCES customer_env(org_key, env_key)
);

COMMENT ON TABLE  deployment_log IS 'Audit log of all provisioning operations with error detail and retry tracking.';
COMMENT ON COLUMN deployment_log.deployment_log_id IS 'Auto-increment primary key.';
COMMENT ON COLUMN deployment_log.log_org_key       IS 'FK to customer_org.';
COMMENT ON COLUMN deployment_log.log_env_key       IS 'FK to customer_env (composite with log_org_key).';
COMMENT ON COLUMN deployment_log.action            IS 'Lifecycle action performed: provision | patch | stop | decommission.';
COMMENT ON COLUMN deployment_log.status            IS 'Outcome: success | failed | retrying.';
COMMENT ON COLUMN deployment_log.error_detail      IS 'Structured error output from failed operations (kubectl/curl stderr).';
COMMENT ON COLUMN deployment_log.retry_count       IS 'Number of retry attempts for this operation (max 3 before manual intervention).';
COMMENT ON COLUMN deployment_log.created_date      IS 'Timestamp when this log entry was created.';

-- Index for per-environment log queries
CREATE INDEX IF NOT EXISTS idx_deployment_log_env
  ON deployment_log(log_org_key, log_env_key, created_date DESC);

-- ---------------------------------------------------------------------------
-- worker_state — single-row table tracking the worker polling watermark
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS worker_state (
  id                  INTEGER     PRIMARY KEY DEFAULT 1,
  last_poll_timestamp TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Enforce single-row invariant
  CONSTRAINT single_row CHECK (id = 1)
);

COMMENT ON TABLE  worker_state IS 'Single-row watermark tracking the worker polling state.';
COMMENT ON COLUMN worker_state.last_poll_timestamp IS 'The mod_date watermark from the last completed worker poll cycle.';
COMMENT ON COLUMN worker_state.updated_at          IS 'When this watermark was last updated.';

-- Seed the single worker_state row
INSERT INTO worker_state (id, last_poll_timestamp)
VALUES (1, '1970-01-01T00:00:00Z')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Trigger: auto-update mod_date on customer_org and customer_env
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_mod_date()
RETURNS TRIGGER AS $$
BEGIN
  NEW.mod_date = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER customer_org_mod_date
  BEFORE UPDATE ON customer_org
  FOR EACH ROW EXECUTE FUNCTION update_mod_date();

CREATE OR REPLACE TRIGGER customer_env_mod_date
  BEFORE UPDATE ON customer_env
  FOR EACH ROW EXECUTE FUNCTION update_mod_date();
