-- Migration: Prompt privilege lockdown — enforce least-privilege on prompt_versions.
--
-- Problem:
--   Phase A granted INSERT, UPDATE on oweibo.prompt_versions to oweibo_app
--   as a "seed only path" — but the grant was never revoked.
--   Phase B promised INSERT/UPDATE to gepa_optimizer but never granted it.
--
-- Fix:
--   1. Create gepa_optimizer role (if not exists)
--   2. Grant gepa_optimizer the writes it was designed to have
--   3. Revoke write access from oweibo_app (retains SELECT)
--   4. Grant role membership so oweibo_app can SET LOCAL ROLE gepa_optimizer
--      within transactions (same proven pattern as SET LOCAL app.tenant_id)
--
-- Requires: 20260508_000000_phase_b_distillation.sql already applied.

-- ── 1. Create gepa_optimizer role ────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gepa_optimizer') THEN
    CREATE ROLE gepa_optimizer LOGIN;
    RAISE NOTICE 'Created gepa_optimizer role.';
  END IF;
END;
$$;

-- ── 2. Grant gepa_optimizer schema access + write permissions ────────────────
GRANT USAGE ON SCHEMA oweibo TO gepa_optimizer;

-- prompt_versions: GEPA inserts new candidates; MutationGovernance updates status.
GRANT SELECT, INSERT, UPDATE ON oweibo.prompt_versions TO gepa_optimizer;

-- channels: GEPA updates channel pointers after bandit promotion.
GRANT SELECT, INSERT, UPDATE ON oweibo.channels TO gepa_optimizer;

-- mutation history: audit trail for freeze/guard/unfreeze operations.
GRANT SELECT, INSERT ON oweibo.prompt_slot_mutation_history TO gepa_optimizer;

-- releasable_buckets: GEPA reads aggregated cross-tenant lessons.
-- (Already granted in Phase B, but idempotent re-grant for safety.)
GRANT SELECT ON oweibo.releasable_buckets TO gepa_optimizer;

-- eval_cache: GEPA reads/writes eval results.
GRANT SELECT, INSERT, UPDATE ON oweibo.eval_cache TO gepa_optimizer;

-- gepa_runs: GEPA writes run metadata.
GRANT SELECT, INSERT, UPDATE ON oweibo.gepa_runs TO gepa_optimizer;

-- frontier_embedding_cache: GEPA caches embeddings.
GRANT SELECT, INSERT, UPDATE ON oweibo.frontier_embedding_cache TO gepa_optimizer;

-- ── 3. Lock down oweibo_app — read-only on prompt_versions ───────────────────
-- oweibo_app retains SELECT for CohortRouter, pipeline prompt resolution, etc.
-- Seed data is inserted by the migration superuser, not oweibo_app.
REVOKE INSERT, UPDATE ON oweibo.prompt_versions FROM oweibo_app;

-- ── 4. Role membership — allow SET LOCAL ROLE ────────────────────────────────
-- This enables oweibo_app to escalate within a transaction:
--   BEGIN; SET LOCAL ROLE gepa_optimizer; INSERT INTO ...; COMMIT;
-- SET LOCAL is transaction-scoped — automatically resets on COMMIT/ROLLBACK.
-- Same proven pattern as SET LOCAL app.tenant_id in withTenantContext.ts.
GRANT gepa_optimizer TO oweibo_app;

-- ── Notify ───────────────────────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE 'Prompt privilege lockdown applied: oweibo_app is now read-only on prompt_versions. Use SET LOCAL ROLE gepa_optimizer for writes.';
END;
$$;
