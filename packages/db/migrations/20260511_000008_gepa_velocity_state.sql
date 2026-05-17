-- Migration: §10.7 — GEPA velocity state (cost-of-learning governor).
-- Closes audit-5 #10: marginal-utility throttling for per-slot GEPA activity.
--
-- Weekly cron (apps/gepa-velocity-tracker) computes per-slot frontier
-- hypervolume gain Δ and classifies each slot into a velocity tier.
-- apps/gepa-optimizer reads this table at run start to decide offspring
-- count, cadence, and whether to skip converged slots.
--
-- Velocity tiers (§10.7):
--   healthy     — Δ_week / Δ_baseline ≥ 1.0 — full nightly cadence
--   slowing     — 0.5 ≤ ratio < 1.0         — reduce offspring count (~33% cost cut)
--   stagnating  — 0.2 ≤ ratio < 0.5         — weekly cadence, reduced parents (~70% cost cut)
--   converged   — ratio < 0.2 sustained ≥7d — optimizer pauses for that slot

-- ── oweibo.gepa_velocity_state ───────────────────────────────────────────────
-- One row per mutable slot. Populated/updated by gepa-velocity-tracker cron.

CREATE TABLE IF NOT EXISTS oweibo.gepa_velocity_state (
  slot_id        TEXT PRIMARY KEY,
  velocity_tier  TEXT NOT NULL CHECK (velocity_tier IN ('healthy', 'slowing', 'stagnating', 'converged')),
  delta_7d       DOUBLE PRECISION NOT NULL,
  delta_baseline DOUBLE PRECISION NOT NULL,
  computed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_velocity_state_tier
  ON oweibo.gepa_velocity_state (velocity_tier);

GRANT SELECT, INSERT, UPDATE ON oweibo.gepa_velocity_state TO oweibo_app;

DO $$
BEGIN
  RAISE NOTICE '§10.7 gepa_velocity_state schema applied.';
END;
$$;
