-- T.2.f: Tenant-installed connector instances.
--
-- The catalog itself lives in code (packages/core-engine/src/seed/connectors/
-- *.json) because it's part of the deployed platform, not tenant-mutable
-- data. This table records the per-tenant installations: one row per
-- (tenant, connector, instance_label) — e.g. a tenant may have a
-- 'postgres-prod' and a 'postgres-dev' instance of the same Postgres
-- connector.
--
-- Credentials are NEVER stored here. The vault_path column points at the
-- Vault hierarchy (oweibo/tenants/<id>/connectors/<connectorId>/<label>);
-- CredentialResolver reads from Vault on demand with a short TTL cache.
--
-- Backwards compatibility: purely additive. Action surfaces that already
-- have hard-coded credential paths continue to work — only when a tenant
-- has installed an instance does CredentialResolver take over.

CREATE TABLE IF NOT EXISTS oweibo.tenant_connectors (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  connector_id    TEXT         NOT NULL,
  catalog_version TEXT         NOT NULL,
  instance_label  TEXT         NOT NULL,
  vault_path      TEXT         NOT NULL,
  status          TEXT         NOT NULL DEFAULT 'pending',
  installed_by    UUID         REFERENCES oweibo.users(id),
  installed_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_used_at    TIMESTAMPTZ,
  metadata        JSONB        NOT NULL DEFAULT '{}'
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_connectors_status_check'
  ) THEN
    ALTER TABLE oweibo.tenant_connectors
      ADD CONSTRAINT tenant_connectors_status_check
      CHECK (status IN ('pending','active','suspended','revoked'))
      NOT VALID;
    ALTER TABLE oweibo.tenant_connectors
      VALIDATE CONSTRAINT tenant_connectors_status_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_connectors_unique_instance'
  ) THEN
    ALTER TABLE oweibo.tenant_connectors
      ADD CONSTRAINT tenant_connectors_unique_instance
      UNIQUE (tenant_id, connector_id, instance_label);
  END IF;
END $$;

ALTER TABLE oweibo.tenant_connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.tenant_connectors FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.tenant_connectors;
CREATE POLICY tenant_isolation ON oweibo.tenant_connectors
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE ON oweibo.tenant_connectors TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_tenant_connectors_tenant_status
  ON oweibo.tenant_connectors (tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_tenant_connectors_connector
  ON oweibo.tenant_connectors (connector_id);

DO $$
BEGIN
  RAISE NOTICE 'T.2.f tenant_connectors installed.';
END;
$$;
