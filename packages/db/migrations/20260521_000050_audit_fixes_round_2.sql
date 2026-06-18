-- Audit fixes round 2 (2026-05-27) — high-severity findings against
-- ttv.md + action-safety-v2.
--
--   * T.1: structured skip_reason column on tenant_bootstrap_steps so
--          the reconciliation sweep can distinguish "mode_too_low (re-
--          attempt)" from "feature_flag_off (terminal)" without fragile
--          last_error string-matching.
--
-- Other high findings addressed in this commit are pure code changes
-- (T.3 prior cap formula, T.5.e cohort_override, S.4 voter eligibility
-- + delegation transitivity, S.1 dual expiry precedence, S.2 cold-start
-- formula pinning, T.7 catalog-lint content-hash uniqueness) and do
-- not need migrations.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'oweibo' AND table_name = 'tenant_bootstrap_steps'
  ) THEN
    RAISE EXCEPTION 'audit-fixes round 2 requires ttv.md T.1 (tenant_bootstrap_steps) to be applied first.';
  END IF;
END $$;

BEGIN;

-- ── T.1: skip_reason ───────────────────────────────────────────────────
-- Nullable for backwards compat with pre-fix rows (they will appear as
-- skip_reason=NULL and be treated as "skip reason unknown" by the
-- BootstrapWorker — i.e. NOT re-attemptable, which is safe).
ALTER TABLE oweibo.tenant_bootstrap_steps
  ADD COLUMN IF NOT EXISTS skip_reason TEXT
    CHECK (skip_reason IS NULL OR skip_reason IN (
      'mode_too_low',
      'feature_flag_off',
      'precondition_not_met',
      'optional_step',
      'no_content'
    ));

-- Partial index keyed to the reconciliation sweep's predicate:
-- "find steps the worker should re-attempt when the tenant matures."
CREATE INDEX IF NOT EXISTS idx_tenant_bootstrap_steps_reattemptable
  ON oweibo.tenant_bootstrap_steps (tenant_id)
  WHERE status = 'skipped' AND skip_reason = 'mode_too_low';

COMMIT;

DO $$
BEGIN
  RAISE NOTICE 'Audit fixes round 2 applied: T.1 skip_reason column.';
END;
$$;
