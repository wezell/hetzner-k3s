-- Migration 005: Add pending_delete flag to customer_env
--
-- When an operator clicks "Delete" on an environment that is not yet
-- decommissioned, the API sets pending_delete = true and triggers the
-- decommission workflow.  The polling worker checks this flag after a
-- successful decommission and hard-deletes the row automatically.

ALTER TABLE customer_env
  ADD COLUMN IF NOT EXISTS pending_delete BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN customer_env.pending_delete IS
  'When true, the polling worker will hard-delete this row from the DB '
  'immediately after decommission completes.';
