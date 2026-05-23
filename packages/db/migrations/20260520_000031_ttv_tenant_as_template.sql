-- T.9: Tenant-as-template — parent/child lineage + parent-admin consent grants.
--
-- Two tables with RLS:
--   1. oweibo.tenant_lineage — one row per child, points at parent + grant
--   2. oweibo.tenant_lineage_consent_grants — pre-authorized child creates
--
-- A child tenant can only be created with `parentTenantId` when the requester
-- passes a `parentConsentGrantId` issued by the parent admin. The handler
-- atomically claims the grant within the same transaction as the tenant
-- INSERT (compare-and-set UPDATE on uses + expires_at — see ttv.md T.9).
--
-- Cycle prevention: BEFORE INSERT trigger walks the parent chain up to depth
-- 32 and raises if it loops. depth=32 is generous; real-world enterprise
-- chains are <5.

BEGIN;

-- ── consent grants ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oweibo.tenant_lineage_consent_grants (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_tenant_id   UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  granted_by_user_id UUID         NOT NULL,
  scopes             TEXT[]       NOT NULL,
  child_slug_prefix  TEXT,
  max_uses           INTEGER      NOT NULL DEFAULT 1,
  uses               INTEGER      NOT NULL DEFAULT 0,
  expires_at         TIMESTAMPTZ  NOT NULL,
  consumed_at        TIMESTAMPTZ,
  revoked_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenant_lineage_grants_uses_in_range'
  ) THEN
    ALTER TABLE oweibo.tenant_lineage_consent_grants
      ADD CONSTRAINT tenant_lineage_grants_uses_in_range
      CHECK (uses >= 0 AND uses <= max_uses AND max_uses BETWEEN 1 AND 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenant_lineage_grants_scopes_nonempty'
  ) THEN
    ALTER TABLE oweibo.tenant_lineage_consent_grants
      ADD CONSTRAINT tenant_lineage_grants_scopes_nonempty
      CHECK (array_length(scopes, 1) >= 1);
  END IF;
END $$;

ALTER TABLE oweibo.tenant_lineage_consent_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.tenant_lineage_consent_grants FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_lineage_grants_parent_manage
  ON oweibo.tenant_lineage_consent_grants
  FOR ALL
  USING (parent_tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY tenant_lineage_grants_platform_admin
  ON oweibo.tenant_lineage_consent_grants
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE ON oweibo.tenant_lineage_consent_grants TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_lineage_grants_parent
  ON oweibo.tenant_lineage_consent_grants (parent_tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lineage_grants_unclaimed
  ON oweibo.tenant_lineage_consent_grants (id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

-- ── lineage rows ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oweibo.tenant_lineage (
  child_tenant_id   UUID         PRIMARY KEY REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  parent_tenant_id  UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE RESTRICT,
  consent_grant_id  UUID         NOT NULL REFERENCES oweibo.tenant_lineage_consent_grants(id),
  cloned_scopes     TEXT[]       NOT NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_lineage_no_self'
  ) THEN
    ALTER TABLE oweibo.tenant_lineage
      ADD CONSTRAINT tenant_lineage_no_self
      CHECK (child_tenant_id <> parent_tenant_id);
  END IF;
END $$;

-- Cycle prevention: child cannot become its own ancestor. Synchronous walk
-- up to depth 32. The walk runs inside the trigger txn so concurrent inserts
-- see each other via the lineage table's row locks at FK-check time.
CREATE OR REPLACE FUNCTION oweibo.check_lineage_no_cycle() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, oweibo
AS $$
DECLARE
  current_id UUID;
  walk_depth INTEGER := 0;
BEGIN
  current_id := NEW.parent_tenant_id;
  WHILE current_id IS NOT NULL AND walk_depth < 32 LOOP
    IF current_id = NEW.child_tenant_id THEN
      RAISE EXCEPTION 'tenant_lineage cycle detected (child=% would re-appear as ancestor)', NEW.child_tenant_id;
    END IF;
    SELECT parent_tenant_id INTO current_id
      FROM oweibo.tenant_lineage
     WHERE child_tenant_id = current_id;
    walk_depth := walk_depth + 1;
  END LOOP;
  IF walk_depth >= 32 THEN
    RAISE EXCEPTION 'tenant_lineage chain exceeds max depth 32';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenant_lineage_no_cycle ON oweibo.tenant_lineage;
CREATE TRIGGER tenant_lineage_no_cycle
  BEFORE INSERT OR UPDATE ON oweibo.tenant_lineage
  FOR EACH ROW EXECUTE FUNCTION oweibo.check_lineage_no_cycle();

ALTER TABLE oweibo.tenant_lineage ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.tenant_lineage FORCE ROW LEVEL SECURITY;

-- Both child and parent can read the lineage row that links them.
CREATE POLICY tenant_lineage_child_read
  ON oweibo.tenant_lineage
  FOR SELECT
  USING (child_tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY tenant_lineage_parent_read
  ON oweibo.tenant_lineage
  FOR SELECT
  USING (parent_tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY tenant_lineage_platform_admin
  ON oweibo.tenant_lineage
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT ON oweibo.tenant_lineage TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_tenant_lineage_parent
  ON oweibo.tenant_lineage (parent_tenant_id, created_at DESC);

COMMIT;

DO $$
BEGIN
  RAISE NOTICE 'T.9 tenant_lineage + consent_grants installed.';
END;
$$;
