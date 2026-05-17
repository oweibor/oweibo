-- Migration: Phase D.15 — Eval-vs-production correlation gauge (§8.3.4 / audit-11).
-- Daily Spearman ρ between eval-suite composite scores and online bandit reward.
-- Requires: 20260508_000001_phase_c_gepa.sql already applied.

CREATE TABLE IF NOT EXISTS oweibo.eval_production_correlation (
  slot_id       TEXT             NOT NULL,
  computed_at   TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  window_start  TIMESTAMPTZ      NOT NULL,
  window_end    TIMESTAMPTZ      NOT NULL,
  spearman_rho  DOUBLE PRECISION NOT NULL,
  sample_size   INT              NOT NULL,
  flagged       BOOLEAN          NOT NULL DEFAULT FALSE,
  PRIMARY KEY (slot_id, computed_at)
);

CREATE INDEX IF NOT EXISTS idx_eval_corr_slot
  ON oweibo.eval_production_correlation (slot_id, computed_at DESC);

GRANT SELECT, INSERT, UPDATE ON oweibo.eval_production_correlation TO oweibo_app;

DO $$
BEGIN
  RAISE NOTICE 'Phase D.15 eval_production_correlation schema applied successfully.';
END;
$$;
