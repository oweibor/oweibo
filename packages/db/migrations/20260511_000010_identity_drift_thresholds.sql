-- §18.8.3 — Identity drift threshold configuration (charter-mutable)
-- Default values: 7d > 0.15, 30d > 0.20, 90d > 0.25, vs-v0 > 0.35

CREATE TABLE IF NOT EXISTS oweibo.identity_drift_thresholds (
  id              BOOLEAN     PRIMARY KEY DEFAULT TRUE CHECK (id),  -- singleton
  threshold_7d    NUMERIC(6,4) NOT NULL DEFAULT 0.15,
  threshold_30d   NUMERIC(6,4) NOT NULL DEFAULT 0.20,
  threshold_90d   NUMERIC(6,4) NOT NULL DEFAULT 0.25,
  threshold_vs_v0 NUMERIC(6,4) NOT NULL DEFAULT 0.35,
  updated_by      TEXT        NOT NULL DEFAULT 'migration:init',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes           TEXT
);

-- Seed with defaults
INSERT INTO oweibo.identity_drift_thresholds DEFAULT VALUES
ON CONFLICT (id) DO NOTHING;

-- Audit log for threshold changes (charter requires change history)
CREATE TABLE IF NOT EXISTS oweibo.identity_drift_threshold_changes (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by      TEXT        NOT NULL,
  prev_threshold_7d    NUMERIC(6,4) NOT NULL,
  prev_threshold_30d   NUMERIC(6,4) NOT NULL,
  prev_threshold_90d   NUMERIC(6,4) NOT NULL,
  prev_threshold_vs_v0 NUMERIC(6,4) NOT NULL,
  new_threshold_7d     NUMERIC(6,4) NOT NULL,
  new_threshold_30d    NUMERIC(6,4) NOT NULL,
  new_threshold_90d    NUMERIC(6,4) NOT NULL,
  new_threshold_vs_v0  NUMERIC(6,4) NOT NULL,
  reason          TEXT        NOT NULL
);
