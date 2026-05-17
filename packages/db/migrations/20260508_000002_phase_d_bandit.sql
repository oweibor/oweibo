-- Migration: Phase D — bandit + cohort rollout schema
-- DONE: Phase D.2 (bandit tables), D.3 (cohort_promotion_rules), D.11 (long-horizon)
-- Requires: 20260508_000001_phase_c_gepa.sql already applied.

-- ── oweibo.bandit_arms ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.bandit_arms (
  arm_id       TEXT         NOT NULL,   -- prompt_versions.hash
  slot_id      TEXT         NOT NULL,
  channel      TEXT         NOT NULL,
  prompt_hash  TEXT         NOT NULL REFERENCES oweibo.prompt_versions(hash),
  alpha        NUMERIC(12,4) NOT NULL DEFAULT 1.0,   -- Beta(alpha, beta) prior
  beta         NUMERIC(12,4) NOT NULL DEFAULT 1.0,
  active       BOOLEAN      NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (arm_id, slot_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_bandit_arms_slot ON oweibo.bandit_arms (slot_id, channel, active);

-- ── oweibo.bandit_arm_events ─────────────────────────────────────────────────
-- Dedup table — closes audit gaps E-03 + G-03.
-- Prevents double-counting late thumbs feedback.

CREATE TABLE IF NOT EXISTS oweibo.bandit_arm_events (
  task_id      TEXT         NOT NULL,
  slot_id      TEXT         NOT NULL,
  arm_id       TEXT         NOT NULL,
  reward       NUMERIC(4,3) NOT NULL CHECK (reward BETWEEN 0 AND 1),
  recorded_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task_id, slot_id, arm_id)
);

-- ── oweibo.cohort_promotion_rules ────────────────────────────────────────────
-- Gate conditions for each promotion tier.

CREATE TABLE IF NOT EXISTS oweibo.cohort_promotion_rules (
  from_channel     TEXT         NOT NULL,
  to_channel       TEXT         NOT NULL,
  soak_days        INTEGER      NOT NULL,
  min_completions  INTEGER      NOT NULL,
  min_quality_delta NUMERIC(5,4) NOT NULL DEFAULT 0.03,
  max_safety_violations INTEGER NOT NULL DEFAULT 0,
  requires_human_approval BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (from_channel, to_channel)
);

INSERT INTO oweibo.cohort_promotion_rules
  (from_channel, to_channel, soak_days, min_completions, requires_human_approval)
VALUES
  ('pending_human_review', 'fast',   0,  0,   false),
  ('fast',                 'beta',   7,  500, false),
  ('beta',                 'stable', 21, 0,   true)   -- human approval required
ON CONFLICT DO NOTHING;

-- ── oweibo.bandit_long_horizon ───────────────────────────────────────────────
-- D.11: Long-horizon reward aggregator output (rolling 14-day delayed signals).

CREATE TABLE IF NOT EXISTS oweibo.bandit_long_horizon (
  slot_id                   TEXT         NOT NULL,
  arm_id                    TEXT         NOT NULL,
  window_end                DATE         NOT NULL,
  rollback_correlation_rate  NUMERIC(5,4),
  post_task_edit_distance    NUMERIC(10,4),
  task_reopen_rate           NUMERIC(5,4),
  user_correction_rate       NUMERIC(5,4),
  late_thumbs_inversion_count INTEGER,
  computed_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (slot_id, arm_id, window_end)
);

-- ── oweibo.system_identity_fingerprints (D.13) ───────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.system_identity_fingerprints (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint_date DATE        NOT NULL UNIQUE,
  role_vectors     JSONB       NOT NULL,   -- {role: embedding_centroid}
  style_metrics    JSONB       NOT NULL,   -- sentence length distribution, vocabulary entropy
  topic_entropy    NUMERIC(6,4),
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oweibo.identity_drift_events (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  detected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  from_fingerprint UUID        REFERENCES oweibo.system_identity_fingerprints(id),
  drift_axis       TEXT        NOT NULL,
  drift_magnitude  NUMERIC(8,4) NOT NULL,
  acknowledged_at  TIMESTAMPTZ,
  acknowledged_by  TEXT
);

-- ── oweibo.elegance_battery_results (D.14) ───────────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.elegance_battery_results (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_month     TEXT        NOT NULL,   -- 'YYYY-MM'
  task_id       TEXT        NOT NULL,
  reviewer_id   TEXT        NOT NULL,
  elegance_grade TEXT       NOT NULL CHECK (elegance_grade IN ('red','yellow','green')),
  complexity_grade TEXT     NOT NULL CHECK (complexity_grade IN ('red','yellow','green')),
  initiative_grade TEXT     NOT NULL CHECK (initiative_grade IN ('red','yellow','green')),
  notes         TEXT,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oweibo.charter_spot_audit_queue (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_type  TEXT        NOT NULL,   -- 'elegance_red', 'drift_event', etc.
  payload       JSONB       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_to   TEXT,
  resolved_at   TIMESTAMPTZ
);

DO $$
BEGIN
  RAISE NOTICE 'Phase D bandit + cohort schema applied successfully.';
END;
$$;
