-- K.9 / ADR-006 §3.1 — the tenant policy store.
--
-- Store scope: TENANT-SCOPED (ADR-000 §4). FORCE RLS + tenant_isolation, in the
-- shape the shipped quota_policies / rate_limit_policies pattern establishes.
--
-- Two schema-level guarantees worth reading before changing anything here:
--
--  1. `category` is CHECKed against the dimension, not supplied freely. ADR-006
--     §3.1: category is a property of the DIMENSION, never of the row — an admin
--     must not be able to re-declare data_residency as 'operational' and thereby
--     demote it from storage-layer enforcement (INV-4) to a planner hint. The
--     constraint is what makes that structurally impossible rather than a
--     convention the service layer is trusted to keep.
--
--  2. `policy_version` is tenant-monotonic and is a structural component of the
--     ADR-001 §3.6 semantic cache key. TenantPolicyService bumps it in the SAME
--     transaction as any value change (ADR-006 §1), so a change can never be
--     visible while stale cache entries remain reachable.
--
-- Sole writer (INV-16): TenantPolicyService. Nothing else writes this table.

BEGIN;

CREATE TABLE IF NOT EXISTS oweibo.kf_tenant_policies (
  tenant_id       UUID        NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  dimension       TEXT        NOT NULL,
  category        TEXT        NOT NULL,
  value           JSONB       NOT NULL,
  policy_version  BIGINT      NOT NULL DEFAULT 1 CHECK (policy_version >= 1),
  effective_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      UUID,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, dimension),

  CONSTRAINT kf_tenant_policies_dimension_known CHECK (
    dimension IN (
      'data_persistence', 'indexing_scope', 'connector_enablement',
      'operation_permissions', 'data_residency', 'classification_exclusions',
      'freshness_sla', 'retrieval_preference'
    )
  ),
  CONSTRAINT kf_tenant_policies_category_valid CHECK (category IN ('compliance', 'operational')),

  -- ADR-006 §3.1: the dimension→category map is FIXED. This constraint is the
  -- enforcement — the map cannot be edited per-row.
  CONSTRAINT kf_tenant_policies_category_matches_dimension CHECK (
    (dimension IN (
       'data_persistence', 'indexing_scope', 'connector_enablement',
       'operation_permissions', 'data_residency', 'classification_exclusions'
     ) AND category = 'compliance')
    OR
    (dimension IN ('freshness_sla', 'retrieval_preference') AND category = 'operational')
  )
);

CREATE INDEX IF NOT EXISTS idx_kf_tenant_policies_version
  ON oweibo.kf_tenant_policies (tenant_id, policy_version);

ALTER TABLE oweibo.kf_tenant_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.kf_tenant_policies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.kf_tenant_policies;
CREATE POLICY tenant_isolation
  ON oweibo.kf_tenant_policies
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS kf_tenant_policies_platform_admin ON oweibo.kf_tenant_policies;
CREATE POLICY kf_tenant_policies_platform_admin
  ON oweibo.kf_tenant_policies
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.kf_tenant_policies TO oweibo_app;

COMMIT;
