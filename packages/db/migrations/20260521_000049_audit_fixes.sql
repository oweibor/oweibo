-- Audit fixes (2026-05-27) for critical findings against ttv.md + action-safety-v2:
--
--   * T.2.h:  org_nodes.user_id FK had no ON DELETE clause; GDPR user-delete
--             hit FK violations for any user in the org graph.
--             Fix: ON DELETE SET NULL so the node persists as an unbound
--             "orphan" surfaced via the admin "review needed" list.
--   * S.0:    Migration 20260521_000041 created `action_lineage` partitioned
--             with an FK to `action_plans`. On Postgres < 14 FKs aren't
--             propagated to child partitions, so orphaned rows could be
--             inserted without error. Assert the minimum version at runtime.
--   * S.3:    `rollback_executions` had no UNIQUE on `original_action_id`.
--             A retry after a transient failure could insert a duplicate
--             row and (if the adapter is buggy) double-apply side effects.
--             Fix: UNIQUE constraint + the orchestrator uses ON CONFLICT.
--
-- Each section is idempotent (`IF NOT EXISTS` / `IF EXISTS`) so the
-- migration is safe to re-run.

BEGIN;

-- ── Postgres version assertion (S.0) ────────────────────────────────────
-- FKs on partitioned tables propagate to children only on PG 14+.
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 140000 THEN
    RAISE EXCEPTION
      'audit-fixes migration requires Postgres 14+ for partitioned-table FK propagation (S.0 action_lineage)';
  END IF;
END $$;

-- ── T.2.h: ON DELETE SET NULL on org_nodes.user_id ──────────────────────
-- Postgres can't ALTER an existing FK's ON DELETE clause in place; drop
-- and re-create. The constraint name was implicit on the original CREATE
-- TABLE; we look it up dynamically so we don't depend on a specific name.
DO $$
DECLARE
  fk_name TEXT;
BEGIN
  SELECT con.conname
    INTO fk_name
    FROM pg_constraint con
    JOIN pg_class cls ON cls.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = cls.relnamespace
   WHERE ns.nspname = 'oweibo'
     AND cls.relname = 'org_nodes'
     AND con.contype = 'f'
     AND con.confrelid = 'oweibo.users'::regclass
     AND con.conkey = ARRAY[
       (SELECT attnum FROM pg_attribute
          WHERE attrelid = 'oweibo.org_nodes'::regclass AND attname = 'user_id')
     ]
   LIMIT 1;

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE oweibo.org_nodes DROP CONSTRAINT %I', fk_name);
  END IF;

  ALTER TABLE oweibo.org_nodes
    ADD CONSTRAINT org_nodes_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES oweibo.users(id) ON DELETE SET NULL;
END $$;

-- Index supporting the "find orphaned person nodes" admin query.
CREATE INDEX IF NOT EXISTS idx_org_nodes_orphaned_persons
  ON oweibo.org_nodes (tenant_id, created_at DESC)
  WHERE user_id IS NULL AND node_type = 'person';

-- ── S.1 TaskEventBus: action_proposals.originating_task_id ─────────────
-- The lifecycle worker publishes a wake event when a proposal expires;
-- the event payload carries originating_task_id so the agent runtime
-- can resume the paused task. Today the only place that id lives is
-- action_plans (S.0), but not every proposal has a plan. Cheap to add
-- the column directly — nullable, with an index on the lookup path.
ALTER TABLE oweibo.action_proposals
  ADD COLUMN IF NOT EXISTS originating_task_id UUID;

CREATE INDEX IF NOT EXISTS idx_action_proposals_originating_task
  ON oweibo.action_proposals (originating_task_id)
  WHERE originating_task_id IS NOT NULL;

-- ── S.0: action_plans.estimated_cost_usd_cents nullable ────────────────
-- The original migration declared this NOT NULL DEFAULT 0, conflating
-- "unknown cost" with "free." The TS contract was updated to
-- `number | null`; the column needs to match so a deferred BudgetEstimator
-- estimate isn't silently coerced to 0 and waved past cost-quota checks.
ALTER TABLE oweibo.action_plans
  ALTER COLUMN estimated_cost_usd_cents DROP NOT NULL;

-- Mirror change on action_proposals.blast_radius_contribution (the
-- contribution row); S.0 stored this as JSONB so the change is a
-- contract-only fix — no DDL needed for that column.

-- ── S.3: UNIQUE (original_action_id) on rollback_executions ─────────────
-- Adopting this constraint requires deduping any existing rows. The
-- feature flag ROLLBACK_EXECUTION_ENABLED is off by default and there
-- should be zero rows in production at this point — but be safe and
-- collapse duplicates if present.
DELETE FROM oweibo.rollback_executions a
 USING oweibo.rollback_executions b
 WHERE a.original_action_id = b.original_action_id
   AND a.started_at < b.started_at;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'rollback_executions_original_action_unique'
       AND conrelid = 'oweibo.rollback_executions'::regclass
  ) THEN
    ALTER TABLE oweibo.rollback_executions
      ADD CONSTRAINT rollback_executions_original_action_unique
        UNIQUE (original_action_id);
  END IF;
END $$;

COMMIT;

DO $$
BEGIN
  RAISE NOTICE 'Audit fixes applied: T.2.h ON DELETE SET NULL, S.0 PG14+ assertion, S.3 UNIQUE.';
END;
$$;
