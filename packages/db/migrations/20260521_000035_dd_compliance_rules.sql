-- D.3 (domain-depth): compliance_rule_evaluations — per-rule, per-action
-- audit row. Generic platform rules (SEC-NNN scanners) live in
-- compliance_violations from earlier migrations; this table is for
-- domain-rule-pack evaluations against ActionContext (action_time) or
-- ArtifactBundle (artifact_time).
--
-- Bypass-aware: when a platform-admin bypasses a rule whose
-- `bypassPolicy = 'platform_admin_only'`, the bypass is logged here
-- with the principal + justification so audit can reconstruct who
-- bypassed what and when.

CREATE TABLE IF NOT EXISTS oweibo.compliance_rule_evaluations (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  proposal_id     UUID,
  rule_id         TEXT         NOT NULL,
  domain_slug     TEXT         REFERENCES oweibo.domain_catalog(slug),
  pack_version    TEXT         NOT NULL,
  enforcement_phase TEXT       NOT NULL CHECK (enforcement_phase IN ('action_time','artifact_time')),
  verdict         TEXT         NOT NULL CHECK (verdict IN ('pass','info','warn','block','bypass')),
  details         JSONB        NOT NULL DEFAULT '{}',
  bypass_principal TEXT,
  bypass_reason    TEXT,
  evaluated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE oweibo.compliance_rule_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.compliance_rule_evaluations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.compliance_rule_evaluations;
CREATE POLICY tenant_isolation ON oweibo.compliance_rule_evaluations
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT ON oweibo.compliance_rule_evaluations TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_compliance_rule_evaluations_proposal
  ON oweibo.compliance_rule_evaluations (proposal_id)
  WHERE proposal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_compliance_rule_evaluations_block
  ON oweibo.compliance_rule_evaluations (tenant_id, evaluated_at DESC)
  WHERE verdict IN ('block','bypass');
CREATE INDEX IF NOT EXISTS idx_compliance_rule_evaluations_domain
  ON oweibo.compliance_rule_evaluations (domain_slug, evaluated_at DESC)
  WHERE domain_slug IS NOT NULL;

DO $$
BEGIN
  RAISE NOTICE 'D.3 compliance_rule_evaluations installed.';
END;
$$;
