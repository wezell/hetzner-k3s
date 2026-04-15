-- Migration 004: Add 'decommissioning' as a valid deploy_status value.
--
-- The 'decommissioning' state is an intermediate status set by the polling
-- worker when it detects that an environment's dcomm_date has elapsed and
-- begins the full teardown sequence (DB/role drop, OpenSearch index delete,
-- S3 bucket removal, Kustomize resource deletion, namespace teardown).
--
-- Before this migration the worker transitioned directly from the current
-- state → 'decommissioned', which made it impossible for operators to see
-- that teardown was in progress.  The new intermediate state gives the
-- dashboard a distinct animated badge while teardown runs.
--
-- State machine addition:
--   <any non-decommissioned>  → decommissioning  (dcomm_date elapsed, worker detected)
--   decommissioning           → decommissioned    (all resources removed)
--   decommissioning           → failed            (3 retries exhausted)

ALTER TABLE customer_env
  DROP CONSTRAINT IF EXISTS customer_env_deploy_status_check;

ALTER TABLE customer_env
  ADD CONSTRAINT customer_env_deploy_status_check
  CHECK (deploy_status IN (
    'pending', 'provisioning', 'deployed',
    'reconfiguring', 'stopping', 'failed', 'stopped',
    'decommissioning', 'decommissioned'
  ));

COMMENT ON COLUMN customer_env.deploy_status IS
  'Current deployment state: pending | provisioning | deployed | reconfiguring | stopping | failed | stopped | decommissioning | decommissioned.';
