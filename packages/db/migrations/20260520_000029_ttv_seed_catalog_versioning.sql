-- T.7: per-tenant seed-install log + pending catalog updates.
--
-- tenant_seed_install_log: one row per (tenant, seed_id) tracking the
-- content_hash that was installed. The hash, not the catalog_version
-- string, is the discriminator — version strings can collide across
-- hotfixes.
--
-- tenant_catalog_pending_updates: surfaced to tenant admins via the
-- catalog-updates admin page. Each row represents a diff the reconciler
-- detected; resolution is install or dismiss.
--
-- Backwards compatibility: both tables are purely additive. With the
-- seed_catalog_versioning.enabled flag off, no rows are written and
-- existing tenants are unaffected.

CREATE TABLE IF NOT EXISTS oweibo.tenant_seed_install_log (
  tenant_id        UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  seed_id          TEXT         NOT NULL,
  catalog_version  TEXT         NOT NULL,
  content_hash     TEXT         NOT NULL,
  installed_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  retired_at       TIMESTAMPTZ,
  retirement_reason TEXT,
  PRIMARY KEY (tenant_id, seed_id)
);

ALTER TABLE oweibo.tenant_seed_install_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.tenant_seed_install_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.tenant_seed_install_log;
CREATE POLICY tenant_isolation ON oweibo.tenant_seed_install_log
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE ON oweibo.tenant_seed_install_log TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_tenant_seed_install_log_active
  ON oweibo.tenant_seed_install_log (tenant_id, seed_id)
  WHERE retired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tenant_seed_install_log_hash
  ON oweibo.tenant_seed_install_log (seed_id, content_hash)
  WHERE retired_at IS NULL;

-- ── tenant_catalog_pending_updates ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.tenant_catalog_pending_updates (
  tenant_id            UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  seed_id              TEXT         NOT NULL,
  from_catalog_version TEXT         NOT NULL,
  to_catalog_version   TEXT         NOT NULL,
  from_content_hash    TEXT,
  to_content_hash      TEXT         NOT NULL,
  change_kind          TEXT         NOT NULL,
  preview_payload      JSONB        NOT NULL,
  detected_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  resolved_at          TIMESTAMPTZ,
  resolution           TEXT,
  resolved_by          UUID         REFERENCES oweibo.users(id),
  PRIMARY KEY (tenant_id, seed_id, to_content_hash)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_catalog_pending_change_kind_check'
  ) THEN
    ALTER TABLE oweibo.tenant_catalog_pending_updates
      ADD CONSTRAINT tenant_catalog_pending_change_kind_check
      CHECK (change_kind IN ('additive','revision','removal'))
      NOT VALID;
    ALTER TABLE oweibo.tenant_catalog_pending_updates
      VALIDATE CONSTRAINT tenant_catalog_pending_change_kind_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_catalog_pending_resolution_check'
  ) THEN
    ALTER TABLE oweibo.tenant_catalog_pending_updates
      ADD CONSTRAINT tenant_catalog_pending_resolution_check
      CHECK (resolution IS NULL OR resolution IN ('installed','dismissed'))
      NOT VALID;
    ALTER TABLE oweibo.tenant_catalog_pending_updates
      VALIDATE CONSTRAINT tenant_catalog_pending_resolution_check;
  END IF;
END $$;

ALTER TABLE oweibo.tenant_catalog_pending_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.tenant_catalog_pending_updates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.tenant_catalog_pending_updates;
CREATE POLICY tenant_isolation ON oweibo.tenant_catalog_pending_updates
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE ON oweibo.tenant_catalog_pending_updates TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_tenant_catalog_pending_unresolved
  ON oweibo.tenant_catalog_pending_updates (tenant_id, detected_at DESC)
  WHERE resolved_at IS NULL;

DO $$
BEGIN
  RAISE NOTICE 'T.7 seed-catalog versioning installed.';
END;
$$;
