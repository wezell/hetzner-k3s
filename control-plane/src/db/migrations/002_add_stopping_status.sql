-- Migration 002: Add 'stopping' as a valid deploy_status value.
--
-- The 'stopping' state is an intermediate status set by the polling worker when
-- it detects a deployed environment whose stop_date has elapsed (stop_date <= NOW()).
-- The worker enqueues it here before actually scaling the Deployment to 0 replicas,
-- which transitions it to 'stopped'.
--
-- State machine addition:
--   deployed  → stopping  (stop_date elapsed, worker detected & enqueued)
--   stopping  → stopped   (scale-to-zero complete)
--   stopping  → failed    (3 retries exhausted)

ALTER TABLE customer_env
  DROP CONSTRAINT IF EXISTS customer_env_deploy_status_check;

ALTER TABLE customer_env
  ADD CONSTRAINT customer_env_deploy_status_check
  CHECK (deploy_status IN (
    'pending','provisioning','deployed',
    'stopping','failed','stopped','decommissioned'
  ));

COMMENT ON COLUMN customer_env.deploy_status IS
  'Current deployment state: pending | provisioning | deployed | stopping | failed | stopped | decommissioned.';
