-- D.8 (domain-depth): depth measurement + per-tenant utilization
-- snapshots, plus per-domain target backfill into the catalog.
--
-- Two tables:
--   * domain_depth_snapshots       — weekly per-domain composite scores
--                                    + JSONB sub-coverage breakdowns.
--   * tenant_domain_utilization    — daily per-(tenant, domain) usage.
--
-- Plus an idempotent backfill of `depth_targets` on
-- `oweibo.domain_catalog` (column added in D.0 with default '{}'):
-- empty defaults make every component score 0, so admin-curated
-- targets must land before the composite score is meaningful.

-- ── domain_depth_snapshots ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oweibo.domain_depth_snapshots (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_slug         TEXT         NOT NULL REFERENCES oweibo.domain_catalog(slug),
  snapshot_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  composite_score     NUMERIC(5,2) NOT NULL CHECK (composite_score BETWEEN 0 AND 100),
  recommended_tier    TEXT         NOT NULL CHECK (recommended_tier IN ('experimental','beta','general_availability','deprecated')),
  ontology_coverage   JSONB        NOT NULL DEFAULT '{}',
  eval_coverage       JSONB        NOT NULL DEFAULT '{}',
  compliance_coverage JSONB        NOT NULL DEFAULT '{}',
  connector_coverage  JSONB        NOT NULL DEFAULT '{}',
  sme_coverage        JSONB        NOT NULL DEFAULT '{}'
);

ALTER TABLE oweibo.domain_depth_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.domain_depth_snapshots FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS read_any ON oweibo.domain_depth_snapshots;
CREATE POLICY read_any ON oweibo.domain_depth_snapshots FOR SELECT USING (true);

DROP POLICY IF EXISTS platform_admin_write ON oweibo.domain_depth_snapshots;
CREATE POLICY platform_admin_write ON oweibo.domain_depth_snapshots
  FOR ALL USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT ON oweibo.domain_depth_snapshots TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_domain_depth_snapshots_recent
  ON oweibo.domain_depth_snapshots (domain_slug, snapshot_at DESC);

-- ── tenant_domain_utilization ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oweibo.tenant_domain_utilization (
  tenant_id                   UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  domain_slug                 TEXT         NOT NULL REFERENCES oweibo.domain_catalog(slug),
  snapshot_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  ontology_recall_count       INTEGER      NOT NULL DEFAULT 0,
  rubric_evaluation_count     INTEGER      NOT NULL DEFAULT 0,
  compliance_evaluation_count INTEGER      NOT NULL DEFAULT 0,
  utilization_ratio           NUMERIC(4,3) NOT NULL CHECK (utilization_ratio BETWEEN 0 AND 1),
  PRIMARY KEY (tenant_id, domain_slug, snapshot_at)
);

ALTER TABLE oweibo.tenant_domain_utilization ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.tenant_domain_utilization FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.tenant_domain_utilization;
CREATE POLICY tenant_isolation ON oweibo.tenant_domain_utilization
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS platform_admin_bypass ON oweibo.tenant_domain_utilization;
CREATE POLICY platform_admin_bypass ON oweibo.tenant_domain_utilization
  FOR ALL USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT ON oweibo.tenant_domain_utilization TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_tenant_domain_utilization_lookup
  ON oweibo.tenant_domain_utilization (tenant_id, domain_slug, snapshot_at DESC);

-- ── depth_targets backfill on domain_catalog ────────────────────────────
-- Idempotent: only updates rows whose depth_targets is still '{}' so a
-- re-run never overwrites admin edits.
UPDATE oweibo.domain_catalog
   SET depth_targets = '{"ontologyEntries": 300, "rubricCount": 8, "ruleCount": 20, "verifiedConnectors": 10, "credentialedSmes": 5}'::jsonb
 WHERE slug = 'fintech' AND depth_targets = '{}'::jsonb;

UPDATE oweibo.domain_catalog
   SET depth_targets = '{"ontologyEntries": 400, "rubricCount": 8, "ruleCount": 25, "verifiedConnectors": 8, "credentialedSmes": 5}'::jsonb
 WHERE slug = 'healthcare' AND depth_targets = '{}'::jsonb;

UPDATE oweibo.domain_catalog
   SET depth_targets = '{"ontologyEntries": 150, "rubricCount": 6, "ruleCount": 12, "verifiedConnectors": 12, "credentialedSmes": 4}'::jsonb
 WHERE slug = 'devops' AND depth_targets = '{}'::jsonb;

UPDATE oweibo.domain_catalog
   SET depth_targets = '{"ontologyEntries": 250, "rubricCount": 6, "ruleCount": 15, "verifiedConnectors": 4, "credentialedSmes": 3}'::jsonb
 WHERE slug = 'legal' AND depth_targets = '{}'::jsonb;

UPDATE oweibo.domain_catalog
   SET depth_targets = '{"ontologyEntries": 200, "rubricCount": 8, "ruleCount": 8, "verifiedConnectors": 10, "credentialedSmes": 4}'::jsonb
 WHERE slug = 'ml-research' AND depth_targets = '{}'::jsonb;

DO $$
BEGIN
  RAISE NOTICE 'D.8 depth metrics schema installed + targets backfilled.';
END;
$$;
