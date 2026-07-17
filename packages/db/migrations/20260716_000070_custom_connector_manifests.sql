-- Custom connectors — tenant-authored connector manifests.
--
-- The platform catalog (ConnectorRegistry, code-shipped *.connector.json) is
-- curated and immutable at runtime. This table is the tenant-scoped
-- complement: a tenant admin registers a connector the platform does not
-- ship, and the install flow accepts it exactly like a catalog entry —
-- same tenant_connectors row, same install-order gate, same policy
-- enablement (ADR-006 absent ⇒ disabled: enabling a custom connector is a
-- dual-controlled relaxation), same blue/green deployment machinery.
--
-- Store scope: TENANT-SCOPED (ADR-000 §4). FORCE RLS + tenant_isolation.
-- Sole writer (INV-16): CustomConnectorService (Integration Runtime — the
-- same subsystem that owns Connector/CapabilityManifest in the §3.6 map).
--
-- Schema-level guarantees:
--  1. connector_id is CHECKed to the 'custom.' prefix — a custom manifest
--     can never collide with or shadow a platform catalog id, and every
--     downstream row that carries the id (kf_jobs, kf_connector_deployments,
--     connector_enablement policy keys) is self-evidently tenant-authored.
--  2. category is CHECKed against the closed ConnectorCategory enum — the
--     same set the SDK enforces at compile time for first-party bundles.
--  3. certification_target is pinned 'experimental' — a tenant cannot
--     self-declare 'verified'/'enterprise'; those tiers are earned through
--     platform certification (ADR-012), never asserted (INV-15).

BEGIN;

CREATE TABLE IF NOT EXISTS oweibo.custom_connector_manifests (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID        NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  connector_id          TEXT        NOT NULL CHECK (connector_id LIKE 'custom.%'),
  display_name          TEXT        NOT NULL,
  category              TEXT        NOT NULL CHECK (category IN (
    'communication', 'source_control', 'database', 'storage',
    'observability', 'payment', 'identity', 'custom'
  )),
  description           TEXT        NOT NULL,
  catalog_version       TEXT        NOT NULL,
  credential_schema     JSONB       NOT NULL,
  -- Declared action capabilities ({capabilityId, summary, actionClass,
  -- inputSchema, outputSchema?}[]). actionClass feeds the trust ladder;
  -- the service layer refuses reserved governance.* classes.
  capabilities          JSONB       NOT NULL DEFAULT '[]',
  -- ADR-009 §3.6 inbound: the manifest is AUTHORITY, the MCP server is
  -- evidence. declared_tools is the ONLY set of tools ever admitted from
  -- this connector's MCP server; advertised-but-undeclared tools are
  -- dropped and flagged (INV-15).
  mcp_server_url        TEXT,
  declared_tools        JSONB       NOT NULL DEFAULT '[]',
  certification_target  TEXT        NOT NULL DEFAULT 'experimental'
                                    CHECK (certification_target = 'experimental'),
  status                TEXT        NOT NULL DEFAULT 'registered'
                                    CHECK (status IN ('registered', 'disabled')),
  created_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT custom_connector_manifests_unique_id UNIQUE (tenant_id, connector_id)
);

CREATE INDEX IF NOT EXISTS idx_custom_connector_manifests_tenant
  ON oweibo.custom_connector_manifests (tenant_id, status);

ALTER TABLE oweibo.custom_connector_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.custom_connector_manifests FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.custom_connector_manifests;
CREATE POLICY tenant_isolation
  ON oweibo.custom_connector_manifests
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS custom_connector_manifests_platform_admin ON oweibo.custom_connector_manifests;
CREATE POLICY custom_connector_manifests_platform_admin
  ON oweibo.custom_connector_manifests
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.custom_connector_manifests TO oweibo_app;

COMMIT;
