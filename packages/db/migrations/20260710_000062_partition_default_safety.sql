-- Defect fix (2026-07-10): DEFAULT partitions for the two RANGE-partitioned
-- tables, found by running the env-gated suites against a fresh, fully
-- migrated database.
--
-- oweibo.audit_log:      001 pre-created only 2026_04 and 2026_05.
-- oweibo.action_lineage: 000041 pre-created only y2026m05 and promised
--                        "subsequent months are created by a maintenance job"
--                        — no such job exists anywhere in the codebase.
--
-- Consequence: every INSERT into either table has failed with "no partition
-- of relation found for row" since 2026-06-01. For audit_log that means
-- append_audit() — the platform's audit trail — has been throwing on every
-- call in any environment past May.
--
-- Fix: DEFAULT partitions as the permanent safety net. Rows for months with
-- no dedicated partition land in the default instead of erroring; a future
-- maintenance job (still worth building — tracked as a gap, not assumed) can
-- create monthly partitions ahead of time and the default simply stays
-- empty. Writes never break either way.

CREATE TABLE IF NOT EXISTS oweibo.audit_log_default
  PARTITION OF oweibo.audit_log DEFAULT;

CREATE TABLE IF NOT EXISTS oweibo.action_lineage_default
  PARTITION OF oweibo.action_lineage DEFAULT;

DO $$
BEGIN
  RAISE NOTICE 'DEFAULT partitions installed for audit_log and action_lineage.';
END;
$$;
