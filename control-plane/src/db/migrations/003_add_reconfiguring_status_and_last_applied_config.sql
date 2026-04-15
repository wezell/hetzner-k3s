-- Migration 003: Add 'reconfiguring' deploy_status and last_applied_config column.
--
-- 'reconfiguring' is an intermediate status set by the polling worker when it
-- detects that a deployed environment's config fields (image, replicas, resource
-- limits, env_vars) differ from the snapshot stored in last_applied_config.
--
-- last_applied_config captures a JSONB snapshot of the configurable fields at
-- the time they were last successfully applied to Kubernetes (provision or patch).
-- NULL means the environment has never been successfully provisioned yet.
--
-- State machine addition:
--   deployed      → reconfiguring  (config change detected vs last_applied_config)
--   reconfiguring → deployed       (kustomize patch applied and pod Ready)
--   reconfiguring → failed         (3 retries exhausted)

-- ---------------------------------------------------------------------------
-- 1. Expand deploy_status check constraint to include 'reconfiguring'
-- ---------------------------------------------------------------------------

ALTER TABLE customer_env
  DROP CONSTRAINT IF EXISTS customer_env_deploy_status_check;

ALTER TABLE customer_env
  ADD CONSTRAINT customer_env_deploy_status_check
  CHECK (deploy_status IN (
    'pending', 'provisioning', 'deployed',
    'reconfiguring', 'stopping', 'failed', 'stopped', 'decommissioned'
  ));

COMMENT ON COLUMN customer_env.deploy_status IS
  'Current deployment state: pending | provisioning | deployed | reconfiguring | stopping | failed | stopped | decommissioned.';

-- ---------------------------------------------------------------------------
-- 2. Add last_applied_config column
-- ---------------------------------------------------------------------------

ALTER TABLE customer_env
  ADD COLUMN IF NOT EXISTS last_applied_config JSONB DEFAULT NULL;

COMMENT ON COLUMN customer_env.last_applied_config IS
  'JSONB snapshot of config fields (image, replicas, resource limits, env_vars) at time of last successful provision or patch. NULL until first successful provision. Used by the poll worker to detect config drift.';
