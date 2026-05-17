-- Migration: §17.5.1 — Platform operational mode state machine.
-- Closes audit-5 #6: mode is now an enforced Postgres-backed state machine, not documentation.
-- Every relevant entry point checks this table before operating.
--
-- Modes (highest = most active):
--   5  Full operation      — all loops live: GEPA, bandit, evals, promotions
--   4  Eval-only           — GEPA evals; no mutations; bandit learning on
--   3  No bandit learning  — CohortRouter resolves arms; reward updates paused
--   2  No GEPA mutations   — Optimizer cron disabled; eval cache reads only
--   1  No promotions       — Channel pointers frozen; no channel promotion
--   0  Full freeze         — CohortRouter returns stable-v0 regardless of channel

-- ── oweibo.platform_operational_mode ─────────────────────────────────────────
-- Singleton row — enforced by PRIMARY KEY on a boolean that must be TRUE.

CREATE TABLE IF NOT EXISTS oweibo.platform_operational_mode (
  singleton_id BOOLEAN     PRIMARY KEY DEFAULT TRUE
                           CHECK (singleton_id),
  current_mode INT         NOT NULL DEFAULT 5
                           CHECK (current_mode BETWEEN 0 AND 5),
  set_by       TEXT        NOT NULL DEFAULT 'migration:init',
  set_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason       TEXT        NOT NULL DEFAULT 'Initial platform launch at full operation',
  auto_trigger TEXT                      -- NULL if manual; populated if auto-triggered
);

-- Seed the initial row at mode 5 (full operation)
INSERT INTO oweibo.platform_operational_mode
  (singleton_id, current_mode, set_by, reason)
VALUES
  (TRUE, 5, 'migration:init', 'Initial platform launch at full operation')
ON CONFLICT (singleton_id) DO NOTHING;

GRANT SELECT, UPDATE ON oweibo.platform_operational_mode TO oweibo_app;

-- ── oweibo.operational_mode_transitions ──────────────────────────────────────
-- Immutable audit log of every mode transition (manual and automatic).

CREATE TABLE IF NOT EXISTS oweibo.operational_mode_transitions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  from_mode    INT         NOT NULL CHECK (from_mode BETWEEN 0 AND 5),
  to_mode      INT         NOT NULL CHECK (to_mode BETWEEN 0 AND 5),
  set_by       TEXT        NOT NULL,
  set_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason       TEXT        NOT NULL,
  auto_trigger TEXT                      -- NULL if manual
);

CREATE INDEX IF NOT EXISTS idx_mode_transitions_set_at
  ON oweibo.operational_mode_transitions (set_at DESC);

GRANT SELECT, INSERT ON oweibo.operational_mode_transitions TO oweibo_app;

DO $$
BEGIN
  RAISE NOTICE '§17.5.1 platform_operational_mode schema applied.';
END;
$$;
