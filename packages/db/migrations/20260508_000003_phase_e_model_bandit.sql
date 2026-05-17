-- Migration: Phase E — ModelRouter bandit-driven tier selection
-- E.1 forTask() bandit, E.2 tracking, E.3 same channel pipeline as prompt bandits.
-- Requires: 20260508_000002_phase_d_bandit.sql already applied.

-- ── oweibo.model_bandit_arms ─────────────────────────────────────────────────
-- Per-(category, model_id) Beta(alpha, beta) arm.
-- category: task category string ('coding', 'planning', etc.)
-- tier:     'small' | 'mid' | 'large'
-- model_id: opaque identifier for the concrete model within that tier.

CREATE TABLE IF NOT EXISTS oweibo.model_bandit_arms (
  category    TEXT         NOT NULL,
  tier        TEXT         NOT NULL CHECK (tier IN ('small', 'mid', 'large')),
  model_id    TEXT         NOT NULL,
  alpha       NUMERIC(12,4) NOT NULL DEFAULT 1.0,
  beta        NUMERIC(12,4) NOT NULL DEFAULT 1.0,
  active      BOOLEAN      NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (category, model_id)
);

CREATE INDEX IF NOT EXISTS idx_model_bandit_arms_category
  ON oweibo.model_bandit_arms (category, active);

-- Seed default arms for common task categories.
-- In production: add arms per deployed model set via admin CLI.
INSERT INTO oweibo.model_bandit_arms (category, tier, model_id) VALUES
  ('coding',        'mid',   'default'),
  ('debugging',     'mid',   'default'),
  ('planning',      'large', 'default'),
  ('analysis',      'large', 'default'),
  ('refactoring',   'large', 'default'),
  ('documentation', 'mid',   'default'),
  ('summarisation', 'small', 'default'),
  ('file_read',     'small', 'default'),
  ('symbol_lookup', 'small', 'default'),
  ('governance',    'small', 'default')
ON CONFLICT DO NOTHING;

-- ── oweibo.model_bandit_events ───────────────────────────────────────────────
-- Dedup reward table — mirrors bandit_arm_events pattern (E.2).

CREATE TABLE IF NOT EXISTS oweibo.model_bandit_events (
  task_id     TEXT         NOT NULL,
  category    TEXT         NOT NULL,
  tier        TEXT         NOT NULL,
  model_id    TEXT         NOT NULL,
  reward      NUMERIC(4,3) NOT NULL CHECK (reward BETWEEN 0 AND 1),
  recorded_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task_id, category, model_id)
);

-- ── oweibo.model_canary_channels ─────────────────────────────────────────────
-- E.3: same channel/canary/rollback pipeline as prompt bandits (simplified).
-- Tracks which model_id is active per (category, channel).

CREATE TABLE IF NOT EXISTS oweibo.model_canary_channels (
  category     TEXT        NOT NULL,
  channel      TEXT        NOT NULL,   -- 'stable', 'beta', 'fast'
  model_id     TEXT        NOT NULL,
  version      BIGINT      NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   TEXT,
  PRIMARY KEY (category, channel)
);

INSERT INTO oweibo.model_canary_channels (category, channel, model_id) VALUES
  ('coding',        'stable', 'default'),
  ('planning',      'stable', 'default'),
  ('analysis',      'stable', 'default'),
  ('debugging',     'stable', 'default'),
  ('documentation', 'stable', 'default'),
  ('refactoring',   'stable', 'default'),
  ('summarisation', 'stable', 'default'),
  ('file_read',     'stable', 'default'),
  ('symbol_lookup', 'stable', 'default'),
  ('governance',    'stable', 'default')
ON CONFLICT DO NOTHING;

-- Grants: model bandit tables are platform-admin only — not tenant-accessible.
GRANT SELECT, INSERT, UPDATE ON oweibo.model_bandit_arms    TO oweibo_app;
GRANT SELECT, INSERT         ON oweibo.model_bandit_events  TO oweibo_app;
GRANT SELECT, INSERT, UPDATE ON oweibo.model_canary_channels TO oweibo_app;

DO $$
BEGIN
  RAISE NOTICE 'Phase E model bandit schema applied successfully.';
END;
$$;
