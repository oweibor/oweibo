-- K.0 (knowledge fabric): kf_chunks — field-boundary-aware chunk records.
--
-- Schema owned by ADR-003 (schema chapter, ratified 2026-07-10). Sole writer:
-- Knowledge Runtime / Indexing Service. A chunk NEVER spans fields of
-- different freshness classes (arch §5.4). The vector itself lives in Qdrant
-- (ADR-000 embedding-substrate reuse) — embedding_ref is the Qdrant point id,
-- NULL until embedded. chunk_hash enables chunk-diff reindexing (§14.3).
--
-- Tenant-scoped per ADR-000 §3.4: FORCE RLS + tenant_isolation.

CREATE TABLE IF NOT EXISTS oweibo.kf_chunks (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  knowledge_object_id  UUID         NOT NULL REFERENCES oweibo.kf_knowledge_objects(id) ON DELETE CASCADE,
  field_name           TEXT         NOT NULL,
  span_start           INT          NOT NULL,
  span_end             INT          NOT NULL,
  freshness_class      TEXT         NOT NULL,
  chunk_hash           TEXT         NOT NULL,
  embedding_ref        TEXT,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kf_chunks_freshness_check'
  ) THEN
    ALTER TABLE oweibo.kf_chunks
      ADD CONSTRAINT kf_chunks_freshness_check
      CHECK (freshness_class IN ('static','operational','transactional','critical'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kf_chunks_span_check'
  ) THEN
    ALTER TABLE oweibo.kf_chunks
      ADD CONSTRAINT kf_chunks_span_check
      CHECK (span_start >= 0 AND span_end >= span_start);
  END IF;
END $$;

ALTER TABLE oweibo.kf_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.kf_chunks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.kf_chunks;
CREATE POLICY tenant_isolation ON oweibo.kf_chunks
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.kf_chunks TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_kf_chunks_tenant_object
  ON oweibo.kf_chunks (tenant_id, knowledge_object_id);

DO $$
BEGIN
  RAISE NOTICE 'K.0 kf_chunks installed.';
END;
$$;
