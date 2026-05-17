-- Migration: Phase A.9 — backfill stable-v0 pins on pre-existing tasks
-- DONE: Phase A.9
-- Safe to run multiple times (WHERE clause is idempotent).
-- Run AFTER 20260507_000000_phase_a_foundations.sql.

-- All tasks that were created before the prompt-versioning columns were added
-- (identifiable by NULL on architect_assembled_hash) get pinned to 'stable-v0'
-- so the TenantDistillationWorker can join them against oweibo.prompt_versions
-- without special-casing NULLs.

BEGIN;

UPDATE oweibo.tasks
SET
  architect_assembled_hash  = 'stable-v0',
  executor_assembled_hash   = 'stable-v0',
  reviewer_assembled_hash   = 'stable-v0',
  decomposer_assembled_hash = 'stable-v0',
  cohort_channel            = 'stable-v0',
  slot_pin_detail           = '[]'::jsonb
WHERE
  architect_assembled_hash IS NULL;

-- Record how many rows were backfilled in a notice (visible in psql / migration logs).
DO $$
DECLARE
  n BIGINT;
BEGIN
  SELECT COUNT(*) INTO n FROM oweibo.tasks WHERE architect_assembled_hash = 'stable-v0' AND slot_pin_detail = '[]'::jsonb;
  RAISE NOTICE 'Phase A.9 backfill complete: % task rows now pinned to stable-v0', n;
END;
$$;

COMMIT;
