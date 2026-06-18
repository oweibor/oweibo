-- T.2.g: Active domain intake — one row per tenant captures the intake
-- lifecycle, classifier output, and the resulting recommendations the
-- admin UI surfaces back to the operator.
--
-- The step is opt-in: a tenant only runs intake if its row.intake_state
-- is 'requested' (set when the operator submits the wizard). Default
-- 'pending' means no intake started; the row exists for every tenant so
-- the worker can short-circuit cleanly.

CREATE TABLE IF NOT EXISTS oweibo.tenant_domain_intake (
  tenant_id                 UUID         PRIMARY KEY REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  intake_state              TEXT         NOT NULL DEFAULT 'pending',
  classified_domain         TEXT,
  classified_confidence     NUMERIC(4,3),
  primer_doc_count          INTEGER      NOT NULL DEFAULT 0,
  primer_token_count        INTEGER      NOT NULL DEFAULT 0,
  repo_scan_summary         JSONB,
  interview_answers         JSONB,
  recommended_template_slug TEXT,
  recommended_connectors    TEXT[]       NOT NULL DEFAULT '{}',
  recommended_seed_skills   TEXT[]       NOT NULL DEFAULT '{}',
  started_at                TIMESTAMPTZ,
  completed_at              TIMESTAMPTZ,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_domain_intake_state_check'
  ) THEN
    ALTER TABLE oweibo.tenant_domain_intake
      ADD CONSTRAINT tenant_domain_intake_state_check
      CHECK (intake_state IN ('pending','requested','processing','complete','skipped','failed'))
      NOT VALID;
    ALTER TABLE oweibo.tenant_domain_intake
      VALIDATE CONSTRAINT tenant_domain_intake_state_check;
  END IF;
END $$;

ALTER TABLE oweibo.tenant_domain_intake ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.tenant_domain_intake FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.tenant_domain_intake;
CREATE POLICY tenant_isolation ON oweibo.tenant_domain_intake
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE ON oweibo.tenant_domain_intake TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_tenant_domain_intake_state
  ON oweibo.tenant_domain_intake (intake_state)
  WHERE intake_state IN ('requested','processing','failed');

DO $$
BEGIN
  RAISE NOTICE 'T.2.g tenant_domain_intake installed.';
END;
$$;
