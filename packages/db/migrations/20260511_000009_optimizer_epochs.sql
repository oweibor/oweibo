-- §17.5.2 — Optimizer Epoch Recovery
-- Stores metadata for deterministically replayable optimizer snapshots.
-- Snapshot binaries live in MinIO; this table is the catalogue.

CREATE TABLE IF NOT EXISTS oweibo.optimizer_epochs (
  id           TEXT        PRIMARY KEY,     -- 'epoch_2026-05-07T03:00:00Z' or human label
  label        TEXT,                        -- NULL for daily auto; non-null after epoch tag
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  components   JSONB       NOT NULL,        -- map of component_name → minio object path
  retention    TEXT        NOT NULL CHECK (retention IN ('90d_hot', 'tagged_indefinite')),
  replay_verified_at TIMESTAMPTZ,           -- set when --replay-evals completed successfully
  replay_score_delta DOUBLE PRECISION,      -- max absolute score deviation seen during replay
  notes        TEXT
);

-- Index for listing by capture date (most common query)
CREATE INDEX IF NOT EXISTS idx_optimizer_epochs_captured_at
  ON oweibo.optimizer_epochs (captured_at DESC);

-- Index for tagged epochs (indefinite retention — queried by label)
CREATE INDEX IF NOT EXISTS idx_optimizer_epochs_label
  ON oweibo.optimizer_epochs (label)
  WHERE label IS NOT NULL;

-- Partial index for 90d_hot epochs (expiry sweep)
CREATE INDEX IF NOT EXISTS idx_optimizer_epochs_retention_hot
  ON oweibo.optimizer_epochs (captured_at)
  WHERE retention = '90d_hot';
