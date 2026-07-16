-- K.0 (knowledge fabric): kf_jobs + kf_leases — the scheduler substrate.
-- TWO tables in one file — the store-scope manifest registers each
-- individually.
--
-- Schemas owned by ADR-013 §3.1 (Ratified 2026-07-09). Sole writer:
-- Integration Runtime / scheduler (ADR-000 §3.6 "Job / Lease"). Other
-- subsystems enqueue by emitting events the scheduler consumes — never by
-- writing kf_jobs directly.
--
-- kf_jobs: durable priority queue. Claim = FOR UPDATE SKIP LOCKED on
--   (job_class ASC, created_at ASC) — the OutboxRelay pattern. Ordering NEVER
--   consults wall-clock comparison across sources (INV-7).
-- kf_leases: worker ownership with MONOTONIC fencing tokens (INV-8) —
--   incremented on every (re)acquire; a stale token is rejected on write.
--   Advisory locks (runWithAdvisoryLock) are NOT this mechanism: they give
--   exclusion without fencing and are reserved for idempotent skip-safe ticks.
--
-- Both tenant-scoped per ADR-000 §3.4: FORCE RLS + tenant_isolation.

-- ── kf_jobs ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.kf_jobs (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  connector_id     TEXT         NOT NULL,
  job_class        SMALLINT     NOT NULL,
  partition_key    TEXT,
  idempotency_key  TEXT         NOT NULL,
  state            TEXT         NOT NULL DEFAULT 'queued',
  checkpoint       JSONB,
  attempts         INT          NOT NULL DEFAULT 0,
  run_after        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kf_jobs_class_check'
  ) THEN
    ALTER TABLE oweibo.kf_jobs
      ADD CONSTRAINT kf_jobs_class_check
      CHECK (job_class BETWEEN 1 AND 5);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kf_jobs_state_check'
  ) THEN
    ALTER TABLE oweibo.kf_jobs
      ADD CONSTRAINT kf_jobs_state_check
      CHECK (state IN ('queued','leased','succeeded','failed','dead','cancelled'));
  END IF;

  -- Duplicate enqueue is a no-op by construction (INV-6, ADR-013 §3.1).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kf_jobs_unique_idempotency'
  ) THEN
    ALTER TABLE oweibo.kf_jobs
      ADD CONSTRAINT kf_jobs_unique_idempotency
      UNIQUE (tenant_id, idempotency_key);
  END IF;
END $$;

ALTER TABLE oweibo.kf_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.kf_jobs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.kf_jobs;
CREATE POLICY tenant_isolation ON oweibo.kf_jobs
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.kf_jobs TO oweibo_app;

-- Claim-path partial index: queued jobs in priority order (ADR-013 §3.1).
CREATE INDEX IF NOT EXISTS idx_kf_jobs_claim
  ON oweibo.kf_jobs (job_class, created_at)
  WHERE state = 'queued';

CREATE INDEX IF NOT EXISTS idx_kf_jobs_tenant_state
  ON oweibo.kf_jobs (tenant_id, state);

CREATE INDEX IF NOT EXISTS idx_kf_jobs_tenant_connector
  ON oweibo.kf_jobs (tenant_id, connector_id);

-- ── kf_leases ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.kf_leases (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  scope          TEXT         NOT NULL,
  holder         TEXT         NOT NULL,
  fencing_token  BIGINT       NOT NULL DEFAULT 1,
  expires_at     TIMESTAMPTZ  NOT NULL,
  heartbeat_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  -- One lease row per scope; the row persists across holders so
  -- fencing_token stays monotonic per lease (INV-8).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kf_leases_unique_scope'
  ) THEN
    ALTER TABLE oweibo.kf_leases
      ADD CONSTRAINT kf_leases_unique_scope
      UNIQUE (tenant_id, scope);
  END IF;
END $$;

ALTER TABLE oweibo.kf_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.kf_leases FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.kf_leases;
CREATE POLICY tenant_isolation ON oweibo.kf_leases
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.kf_leases TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_kf_leases_tenant_expiry
  ON oweibo.kf_leases (tenant_id, expires_at);

DO $$
BEGIN
  RAISE NOTICE 'K.0 kf_jobs + kf_leases installed.';
END;
$$;
