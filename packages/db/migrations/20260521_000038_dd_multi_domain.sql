-- D.6 (domain-depth): multi-domain tenant bindings.
--
-- T.2.g classified a tenant into a *single* domain. D.6 generalises to
-- N bindings per tenant with explicit roles (primary | secondary) and
-- advisory weights used in tie-breaking.
--
-- Weights are NOT constrained to sum to 1.0 in the DB. Normalization
-- happens at read time inside TenantDomainBindingService. See the plan
-- §4 D.6 for rationale (atomicity + delete ergonomics > raw precision).
--
-- Backfill: every tenant_domain_intake row with a confident
-- classified_domain becomes a single primary binding with weight=1.0.
-- Tenants with classified_domain IS NULL stay binding-less; downstream
-- consumers must handle the empty case gracefully.

CREATE TABLE IF NOT EXISTS oweibo.tenant_domain_binding (
  tenant_id     UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  domain_slug   TEXT         NOT NULL REFERENCES oweibo.domain_catalog(slug),
  role          TEXT         NOT NULL CHECK (role IN ('primary','secondary')),
  weight        NUMERIC(4,3) NOT NULL CHECK (weight BETWEEN 0 AND 1),
  bound_by_type TEXT         NOT NULL CHECK (bound_by_type IN ('classifier','admin','sme')),
  bound_by_id   TEXT         NOT NULL,
  confidence    NUMERIC(4,3),
  bound_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, domain_slug)
);

ALTER TABLE oweibo.tenant_domain_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.tenant_domain_binding FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.tenant_domain_binding;
CREATE POLICY tenant_isolation ON oweibo.tenant_domain_binding
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS platform_admin_bypass ON oweibo.tenant_domain_binding;
CREATE POLICY platform_admin_bypass ON oweibo.tenant_domain_binding
  FOR ALL USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.tenant_domain_binding TO oweibo_app;

-- At most one primary per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_domain_binding_primary
  ON oweibo.tenant_domain_binding (tenant_id) WHERE role = 'primary';

CREATE INDEX IF NOT EXISTS idx_tenant_domain_binding_lookup
  ON oweibo.tenant_domain_binding (tenant_id);

-- ── Backfill ────────────────────────────────────────────────────────────
-- Idempotent: ON CONFLICT DO NOTHING ensures re-running the migration
-- never duplicates a binding. Only inserts rows for tenants that don't
-- already have any binding (the WHERE NOT EXISTS protects against
-- a re-run after an admin has added secondary bindings).
INSERT INTO oweibo.tenant_domain_binding
  (tenant_id, domain_slug, role, weight, bound_by_type, bound_by_id, confidence, bound_at)
SELECT
  i.tenant_id,
  i.classified_domain,
  'primary',
  1.0,
  'classifier',
  'ttv-t2g-backfill',
  COALESCE(i.classified_confidence, 0.7),
  COALESCE(i.completed_at, NOW())
FROM oweibo.tenant_domain_intake i
WHERE i.classified_domain IS NOT NULL
  AND EXISTS (SELECT 1 FROM oweibo.domain_catalog c WHERE c.slug = i.classified_domain)
  AND NOT EXISTS (
    SELECT 1 FROM oweibo.tenant_domain_binding b WHERE b.tenant_id = i.tenant_id
  )
ON CONFLICT (tenant_id, domain_slug) DO NOTHING;

DO $$
BEGIN
  RAISE NOTICE 'D.6 tenant_domain_binding installed + backfilled.';
END;
$$;
