-- D.4 (domain-depth): connector SDK + certification ledger.
--
-- Adds certification metadata to per-tenant connector instances and
-- introduces a platform-wide certification ledger so the CI gate and
-- the admin UI have a single source of truth for which connector
-- versions have passed which tier.
--
-- `tenant_connectors.certification_tier` mirrors the tier of the
-- catalog version installed; `certified_for` is the array of domain
-- slugs the connector was certified for at install time. Both nullable
-- — pre-D.4 rows continue to operate at the experimental tier.

ALTER TABLE oweibo.tenant_connectors
  ADD COLUMN IF NOT EXISTS certification_tier TEXT
    CHECK (certification_tier IS NULL OR certification_tier IN ('experimental','community','verified','enterprise')),
  ADD COLUMN IF NOT EXISTS certified_for TEXT[] NOT NULL DEFAULT '{}';

-- Platform-wide certification ledger. One row per
-- (connector_id, catalog_version) — installing a new catalog_version
-- after a re-cert produces a fresh row; the prior row is preserved as
-- audit (no expires_at update path here).
CREATE TABLE IF NOT EXISTS oweibo.connector_certifications (
  connector_id        TEXT         NOT NULL,
  catalog_version     TEXT         NOT NULL,
  certification_tier  TEXT         NOT NULL CHECK (certification_tier IN ('experimental','community','verified','enterprise')),
  certified_for       TEXT[]       NOT NULL DEFAULT '{}',
  test_suite_hash     TEXT         NOT NULL,
  passed_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ,
  -- 'ci' for automated certification runner, 'platform_admin:<user>' for manual override.
  certifier           TEXT         NOT NULL,
  metadata            JSONB        NOT NULL DEFAULT '{}',
  PRIMARY KEY (connector_id, catalog_version)
);

ALTER TABLE oweibo.connector_certifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.connector_certifications FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS read_any ON oweibo.connector_certifications;
CREATE POLICY read_any ON oweibo.connector_certifications FOR SELECT USING (true);

DROP POLICY IF EXISTS platform_admin_write ON oweibo.connector_certifications;
CREATE POLICY platform_admin_write ON oweibo.connector_certifications
  FOR ALL USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT ON oweibo.connector_certifications TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_connector_certifications_tier
  ON oweibo.connector_certifications (certification_tier)
  WHERE certification_tier IN ('verified','enterprise');

CREATE INDEX IF NOT EXISTS idx_tenant_connectors_certification
  ON oweibo.tenant_connectors (certification_tier)
  WHERE certification_tier IS NOT NULL;

DO $$
BEGIN
  RAISE NOTICE 'D.4 connector certifications installed.';
END;
$$;
