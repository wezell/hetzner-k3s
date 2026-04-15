-- Migration 006: Add last_applied_at to customer_env
--
-- Tracks when last_applied_config was last written by the worker.
-- Used by detectAndEnqueueReconfigs to skip the JSONB drift comparison
-- on environments that haven't been modified since the last successful
-- deployment — keeping the query O(modified) instead of O(total envs).

ALTER TABLE customer_env
  ADD COLUMN IF NOT EXISTS last_applied_at TIMESTAMPTZ;

COMMENT ON COLUMN customer_env.last_applied_at IS
  'Timestamp of the last successful provision or patch. '
  'Drift detection skips rows where mod_date <= last_applied_at.';
