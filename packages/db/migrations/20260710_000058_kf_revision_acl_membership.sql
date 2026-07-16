-- K.0 (knowledge fabric): kf_revision_vectors + kf_acl_snapshots +
-- kf_membership_records. THREE tables in one file — the store-scope manifest
-- (kf-store-scope.test.ts) registers each individually, never per file.
--
-- kf_revision_vectors — ADR-003 schema chapter. Exactly ONE vector per
--   knowledge object (PK on the FK). Multi-source = N entries inside the one
--   `revisions` JSONB, never N rows. Values are monotonic and never rewritten
--   (INV-6/7); updated_at is observability only, NEVER ordering.
--
-- kf_acl_snapshots — ADR-010 schema chapter. Version + hash ONLY — this table
--   NEVER stores the full permission list (arch §6.2, normative). Carries
--   INV-16's single named exception: Retrieval MAY synchronously refresh the
--   snapshot it reads (read-through), emitting ACLUpdated afterward.
--
-- kf_membership_records — ADR-010 schema chapter. Raw principal→group edges;
--   nesting = a group appearing as principal_ref in other rows. NO canonical
--   identity / confidence / resolution state here — those are Identity
--   Resolution's (ADR-002); adding canonical_user_id "for convenience" is a
--   review finding.
--
-- All three tenant-scoped per ADR-000 §3.4: FORCE RLS + tenant_isolation.

-- ── kf_revision_vectors ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.kf_revision_vectors (
  knowledge_object_id  UUID         PRIMARY KEY REFERENCES oweibo.kf_knowledge_objects(id) ON DELETE CASCADE,
  tenant_id            UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  revisions            JSONB        NOT NULL DEFAULT '{}',
  index_generation     BIGINT       NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE oweibo.kf_revision_vectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.kf_revision_vectors FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.kf_revision_vectors;
CREATE POLICY tenant_isolation ON oweibo.kf_revision_vectors
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.kf_revision_vectors TO oweibo_app;

-- ── kf_acl_snapshots ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.kf_acl_snapshots (
  knowledge_object_id  UUID         PRIMARY KEY REFERENCES oweibo.kf_knowledge_objects(id) ON DELETE CASCADE,
  tenant_id            UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  acl_version          BIGINT       NOT NULL,
  permission_hash      TEXT         NOT NULL,
  source_revision      BIGINT       NOT NULL,
  last_checked         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE oweibo.kf_acl_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.kf_acl_snapshots FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.kf_acl_snapshots;
CREATE POLICY tenant_isolation ON oweibo.kf_acl_snapshots
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.kf_acl_snapshots TO oweibo_app;

-- ── kf_membership_records ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.kf_membership_records (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  source              TEXT         NOT NULL,
  principal_ref       TEXT         NOT NULL,
  group_ref           TEXT         NOT NULL,
  membership_version  BIGINT       NOT NULL,
  observed_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kf_membership_records_unique_edge'
  ) THEN
    ALTER TABLE oweibo.kf_membership_records
      ADD CONSTRAINT kf_membership_records_unique_edge
      UNIQUE (tenant_id, source, principal_ref, group_ref);
  END IF;
END $$;

ALTER TABLE oweibo.kf_membership_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.kf_membership_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.kf_membership_records;
CREATE POLICY tenant_isolation ON oweibo.kf_membership_records
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.kf_membership_records TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_kf_membership_tenant_source_group
  ON oweibo.kf_membership_records (tenant_id, source, group_ref);

CREATE INDEX IF NOT EXISTS idx_kf_membership_tenant_source_principal
  ON oweibo.kf_membership_records (tenant_id, source, principal_ref);

DO $$
BEGIN
  RAISE NOTICE 'K.0 kf_revision_vectors + kf_acl_snapshots + kf_membership_records installed.';
END;
$$;
