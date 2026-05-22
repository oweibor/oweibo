-- T.0: Tenant bootstrap state machine + outbox unpublished index.
--
-- Adds two RLS-enforced tables that record the bootstrap lifecycle for every
-- newly-created tenant. Idempotency: PK (tenant_id) on tenant_bootstrap, PK
-- (tenant_id, step_name) on tenant_bootstrap_steps — re-runs are safe.
--
-- The oweibo.outbox table already exists (per the Tenant V1 base schema); this
-- migration only ADDS a partial index used by OutboxRelay to scan unpublished
-- rows efficiently. The IF NOT EXISTS guard makes the index creation idempotent.
--
-- Backwards compatibility: existing tenants remain unbootstrapped — no rows in
-- tenant_bootstrap means the tenant predates T.0 and the state is inferred as
-- 'disabled' by the bootstrap worker.

-- ── Pre-flight: assert oweibo.outbox exists ───────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'oweibo'
       AND table_name   = 'outbox'
  ) THEN
    RAISE EXCEPTION 'T.0 migration requires oweibo.outbox table — base schema appears corrupt';
  END IF;
END $$;

-- ── tenant_bootstrap ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.tenant_bootstrap (
  tenant_id     UUID         PRIMARY KEY REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  state         TEXT         NOT NULL DEFAULT 'pending',
  template_slug TEXT         NOT NULL DEFAULT 'default',
  attempts      INTEGER      NOT NULL DEFAULT 0,
  last_error    TEXT,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_bootstrap_state_check'
  ) THEN
    ALTER TABLE oweibo.tenant_bootstrap
      ADD CONSTRAINT tenant_bootstrap_state_check
      CHECK (state IN ('pending','running','ready','failed','disabled'))
      NOT VALID;
    ALTER TABLE oweibo.tenant_bootstrap
      VALIDATE CONSTRAINT tenant_bootstrap_state_check;
  END IF;
END $$;

ALTER TABLE oweibo.tenant_bootstrap ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.tenant_bootstrap FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.tenant_bootstrap;
CREATE POLICY tenant_isolation ON oweibo.tenant_bootstrap
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE ON oweibo.tenant_bootstrap TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_tenant_bootstrap_state
  ON oweibo.tenant_bootstrap (state) WHERE state IN ('pending','running','failed');

-- ── tenant_bootstrap_steps ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.tenant_bootstrap_steps (
  tenant_id    UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  step_name    TEXT         NOT NULL,
  status       TEXT         NOT NULL,
  attempts     INTEGER      NOT NULL DEFAULT 0,
  last_error   TEXT,
  result       JSONB,
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, step_name)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_bootstrap_steps_status_check'
  ) THEN
    ALTER TABLE oweibo.tenant_bootstrap_steps
      ADD CONSTRAINT tenant_bootstrap_steps_status_check
      CHECK (status IN ('pending','running','ok','skipped','failed'))
      NOT VALID;
    ALTER TABLE oweibo.tenant_bootstrap_steps
      VALIDATE CONSTRAINT tenant_bootstrap_steps_status_check;
  END IF;
END $$;

ALTER TABLE oweibo.tenant_bootstrap_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.tenant_bootstrap_steps FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.tenant_bootstrap_steps;
CREATE POLICY tenant_isolation ON oweibo.tenant_bootstrap_steps
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE ON oweibo.tenant_bootstrap_steps TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_tenant_bootstrap_steps_status
  ON oweibo.tenant_bootstrap_steps (status, tenant_id) WHERE status IN ('pending','running','failed');

-- ── Outbox: partial index for unpublished scan ────────────────────────────
-- Pre-existing oweibo.outbox table is NOT recreated. Only the partial index
-- is added; OutboxRelay relies on it for the polling query.

CREATE INDEX IF NOT EXISTS idx_outbox_unpublished
  ON oweibo.outbox (ts) WHERE published_at IS NULL;

DO $$
BEGIN
  RAISE NOTICE 'T.0 provisioning hooks installed (tenant_bootstrap, tenant_bootstrap_steps, idx_outbox_unpublished).';
END;
$$;
