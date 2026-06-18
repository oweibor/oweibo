-- D.0 (domain-depth): Domain registry.
--
-- One authoritative source for what a "domain" is. Read by everything
-- downstream (D.1 ontology packs, D.2 eval rubrics, D.3 compliance rule
-- packs, D.4 connector recommendations, …). Without it, "fintech" means
-- different things in different code paths.
--
-- Cross-tenant catalog: no tenant_id column. Reads open to any role
-- via read_any; writes restricted to platform_admin so domain slugs are
-- not minted by individual tenants.

CREATE TABLE IF NOT EXISTS oweibo.domain_catalog (
  slug                TEXT         PRIMARY KEY,
  display_name        TEXT         NOT NULL,
  description         TEXT         NOT NULL,
  category            TEXT         NOT NULL CHECK (category IN ('regulated','professional','technical','creative')),
  compliance_postures TEXT[]       NOT NULL DEFAULT '{}',
  archetype_roles     TEXT[]       NOT NULL DEFAULT '{}',
  typical_connectors  TEXT[]       NOT NULL DEFAULT '{}',
  canonical_verbiage  TEXT[]       NOT NULL DEFAULT '{}',
  registry_version    TEXT         NOT NULL,
  maturity            TEXT         NOT NULL DEFAULT 'experimental'
                                   CHECK (maturity IN ('experimental','beta','general_availability','deprecated')),
  -- Per-domain saturation targets consumed by D.8 composite depth score.
  -- Keys: 'ontologyEntries','rubricCount','ruleCount','verifiedConnectors','credentialedSmes'.
  -- All values integers >= 0. Empty {} defaults the depth score to 0 across components.
  depth_targets       JSONB        NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE oweibo.domain_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.domain_catalog FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS read_any ON oweibo.domain_catalog;
CREATE POLICY read_any ON oweibo.domain_catalog FOR SELECT USING (true);

DROP POLICY IF EXISTS platform_admin_write ON oweibo.domain_catalog;
CREATE POLICY platform_admin_write ON oweibo.domain_catalog
  FOR ALL USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT ON oweibo.domain_catalog TO oweibo_app;

-- Seed initial v1 domains. The catalog slugs are stable identifiers; renaming
-- requires a separate migration that handles bound-tenant references.
INSERT INTO oweibo.domain_catalog (slug, display_name, description, category, registry_version, maturity) VALUES
  ('fintech',       'Financial services', 'Banking, payments, lending, capital markets',         'regulated',    '1.0.0', 'beta'),
  ('healthcare',    'Healthcare',         'Provider, payer, clinical research',                  'regulated',    '1.0.0', 'beta'),
  ('legal',         'Legal',              'Law firms, in-house counsel, regulatory affairs',     'regulated',    '1.0.0', 'experimental'),
  ('ml-research',   'ML research',        'Academic and industrial ML R&D',                      'technical',    '1.0.0', 'beta'),
  ('devops',        'DevOps / Platform',  'SRE, infrastructure, platform engineering',           'technical',    '1.0.0', 'general_availability'),
  ('ecommerce',     'E-commerce',         'Retail, marketplace, fulfillment',                    'professional', '1.0.0', 'beta'),
  ('gaming',        'Gaming',             'Game development, live-ops, monetization',            'creative',     '1.0.0', 'experimental'),
  ('media',         'Media / Publishing', 'Editorial, content production, distribution',         'creative',     '1.0.0', 'experimental'),
  ('manufacturing', 'Manufacturing',      'Industrial, supply chain, operations',                'professional', '1.0.0', 'experimental'),
  ('education',     'Education',          'K-12, higher ed, ed-tech',                            'professional', '1.0.0', 'experimental')
ON CONFLICT (slug) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_domain_catalog_maturity
  ON oweibo.domain_catalog (maturity)
  WHERE maturity IN ('beta','general_availability');

DO $$
BEGIN
  RAISE NOTICE 'D.0 domain_catalog installed (10 v1 domains).';
END;
$$;
