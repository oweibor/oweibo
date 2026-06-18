-- D.1 (domain-depth): tenant_ontology_install — records which ontology
-- packs have been installed into a tenant's LTM. The actual ontology
-- entries themselves live in the existing semantic-memory store (Qdrant)
-- tagged `domain:<slug>:ontology` — this table is purely a ledger that
-- lets us avoid duplicate installs and supports D.7 currency tracking
-- (which pack_version a tenant is currently on).
--
-- Composite primary key on (tenant_id, domain_slug) means at most one
-- active install per (tenant, domain). Re-installing a domain (after a
-- pack version bump) UPDATEs the row rather than inserting a second one;
-- retirement is soft via `retired_at`.

CREATE TABLE IF NOT EXISTS oweibo.tenant_ontology_install (
  tenant_id        UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  domain_slug      TEXT         NOT NULL REFERENCES oweibo.domain_catalog(slug),
  pack_version     TEXT         NOT NULL,
  entry_count      INTEGER      NOT NULL DEFAULT 0,
  installed_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  retired_at       TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, domain_slug)
);

ALTER TABLE oweibo.tenant_ontology_install ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.tenant_ontology_install FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.tenant_ontology_install;
CREATE POLICY tenant_isolation ON oweibo.tenant_ontology_install
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE ON oweibo.tenant_ontology_install TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_tenant_ontology_install_active
  ON oweibo.tenant_ontology_install (tenant_id, domain_slug)
  WHERE retired_at IS NULL;

DO $$
BEGIN
  RAISE NOTICE 'D.1 tenant_ontology_install installed.';
END;
$$;
