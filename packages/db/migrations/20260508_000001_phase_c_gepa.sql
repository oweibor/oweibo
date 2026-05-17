-- Migration: Phase C — GEPA optimizer schema
-- DONE: Phase C.2 (EvalCache) + Phase C supporting tables
-- Requires: 20260508_000000_phase_b_distillation.sql already applied.

-- ── oweibo.eval_cache ───────────────────────────────────────────────────────
-- EvalCache keyed by (prompt_hash, task_id, eval_suite_version).
-- Stores output_hash for C.1a determinism verification.

CREATE TABLE IF NOT EXISTS oweibo.eval_cache (
  prompt_hash        TEXT         NOT NULL,
  task_id            TEXT         NOT NULL,
  eval_suite_version TEXT         NOT NULL,
  quality_pass       BOOLEAN      NOT NULL,
  quality_score      NUMERIC(5,4) NOT NULL,
  prompt_tokens      INTEGER      NOT NULL DEFAULT 0,
  completion_tokens  INTEGER      NOT NULL DEFAULT 0,
  latency_ms         INTEGER      NOT NULL DEFAULT 0,
  output_hash        TEXT         NOT NULL,    -- C.1a: SHA256 of agent output
  cached_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (prompt_hash, task_id, eval_suite_version)
);

CREATE INDEX IF NOT EXISTS idx_eval_cache_prompt
  ON oweibo.eval_cache (prompt_hash, eval_suite_version);

-- ── oweibo.gepa_runs ────────────────────────────────────────────────────────
-- Per-nightly-run metadata + idempotency key.

CREATE TABLE IF NOT EXISTS oweibo.gepa_runs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date         DATE        NOT NULL UNIQUE,   -- one run per calendar day
  status           TEXT        NOT NULL DEFAULT 'running'
                               CHECK (status IN ('running','completed','failed','budget_exceeded')),
  slots_processed  INTEGER     NOT NULL DEFAULT 0,
  candidates_generated INTEGER NOT NULL DEFAULT 0,
  frontier_size    INTEGER     NOT NULL DEFAULT 0,
  cost_usd         NUMERIC(10,4) NOT NULL DEFAULT 0,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  error            TEXT
);

-- ── oweibo.frontier_embedding_cache ─────────────────────────────────────────
-- Cache embeddings for prompt_versions to avoid re-computing (C.3a-i).

CREATE TABLE IF NOT EXISTS oweibo.frontier_embedding_cache (
  prompt_hash  TEXT         PRIMARY KEY REFERENCES oweibo.prompt_versions(hash),
  embedding    JSONB        NOT NULL,    -- float array
  model_id     TEXT         NOT NULL,
  computed_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── oweibo.lesson_embedding_cache ───────────────────────────────────────────
-- Cache lesson embeddings for RegurgitationDetector (C.3a-iv).

CREATE TABLE IF NOT EXISTS oweibo.lesson_embedding_cache (
  fingerprint  TEXT         PRIMARY KEY REFERENCES oweibo.platform_lessons(fingerprint),
  embedding    JSONB        NOT NULL,
  model_id     TEXT         NOT NULL,
  computed_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── oweibo.eval_suite_config ────────────────────────────────────────────────
-- Global eval configuration (vendor panel, holdout seed, regurgitation threshold).

CREATE TABLE IF NOT EXISTS oweibo.eval_suite_config (
  key    TEXT PRIMARY KEY,
  value  JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO oweibo.eval_suite_config (key, value) VALUES
  ('reflection_vendor_panel',  '["anthropic"]'),
  ('holdout_rotation_seed',    '"stable"'),
  ('regurgitation_threshold',  '0.85'),
  ('gepa_budget_usd_per_run',  '20'),
  ('k_anonymity_threshold',    '5')
ON CONFLICT (key) DO NOTHING;

DO $$
BEGIN
  RAISE NOTICE 'Phase C GEPA schema applied successfully.';
END;
$$;
