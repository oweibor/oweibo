-- K.0 (knowledge fabric): kf_knowledge_objects — the KnowledgeObject spine.
--
-- Schema owned by ADR-003 (schema chapter, ratified 2026-07-10). Sole writer:
-- Knowledge Runtime / Indexing Service (ADR-000 §3.6, INV-16). Companion rows
-- (revision vector, ACL snapshot, provenance) are carried BY REFERENCE in
-- their own tables, keyed by this table's id — never embedded here (INV-1).
--
-- Deletion contract (ADR-003/ADR-007): 'purged' is a STATE, not a row
-- deletion — the row remains as a tombstone so provenance citations keep
-- resolving. A hard DELETE is reserved for erasure-class operations (GDPR
-- erasure, tenant decommission) and deliberately cascades to companions.
--
-- Tenant-scoped per ADR-000 §3.4: FORCE RLS + tenant_isolation.

CREATE TABLE IF NOT EXISTS oweibo.kf_knowledge_objects (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  connector_id     TEXT         NOT NULL,
  source           TEXT         NOT NULL,
  document_id      TEXT         NOT NULL,
  indexing_depth   TEXT         NOT NULL DEFAULT 'metadata',
  freshness_classes JSONB       NOT NULL DEFAULT '{}',
  state            TEXT         NOT NULL DEFAULT 'discovered',
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kf_knowledge_objects_depth_check'
  ) THEN
    ALTER TABLE oweibo.kf_knowledge_objects
      ADD CONSTRAINT kf_knowledge_objects_depth_check
      CHECK (indexing_depth IN ('metadata','full_content'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kf_knowledge_objects_state_check'
  ) THEN
    ALTER TABLE oweibo.kf_knowledge_objects
      ADD CONSTRAINT kf_knowledge_objects_state_check
      CHECK (state IN ('discovered','indexed','stale','purged'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kf_knowledge_objects_unique_doc'
  ) THEN
    ALTER TABLE oweibo.kf_knowledge_objects
      ADD CONSTRAINT kf_knowledge_objects_unique_doc
      UNIQUE (tenant_id, connector_id, document_id);
  END IF;
END $$;

ALTER TABLE oweibo.kf_knowledge_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.kf_knowledge_objects FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.kf_knowledge_objects;
CREATE POLICY tenant_isolation ON oweibo.kf_knowledge_objects
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.kf_knowledge_objects TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_kf_knowledge_objects_tenant_state
  ON oweibo.kf_knowledge_objects (tenant_id, state);

CREATE INDEX IF NOT EXISTS idx_kf_knowledge_objects_tenant_connector
  ON oweibo.kf_knowledge_objects (tenant_id, connector_id);

DO $$
BEGIN
  RAISE NOTICE 'K.0 kf_knowledge_objects installed.';
END;
$$;
