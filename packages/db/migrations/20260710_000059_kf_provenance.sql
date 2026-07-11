-- K.0 (knowledge fabric): kf_provenance — the citation substrate.
--
-- Schema owned by ADR-007 (schema chapter, ratified 2026-07-10). Sole writer:
-- Knowledge Runtime. One row per (retrieval, contributing knowledge object):
-- a fan-out returning 15 documents writes 15 rows sharing one retrieval_id.
--
-- Append-only except the tier transition (full → summarized/metadata, summary
-- populated). Retrieval facts are NEVER rewritten (INV-14 posture applied to
-- citations); version skew in a row is a fact about the retrieval, preserved
-- verbatim. The ON DELETE CASCADE is erasure-only by contract (ADR-003
-- deletion contract): content purge is a tombstone STATE and keeps this row;
-- only GDPR-erasure/decommission row-DELETEs cascade — citations go too.
--
-- Tenant-scoped per ADR-000 §3.4: FORCE RLS + tenant_isolation.

CREATE TABLE IF NOT EXISTS oweibo.kf_provenance (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  retrieval_id         UUID         NOT NULL,
  knowledge_object_id  UUID         NOT NULL REFERENCES oweibo.kf_knowledge_objects(id) ON DELETE CASCADE,
  source               TEXT         NOT NULL,
  retrieval_path       TEXT         NOT NULL,
  index_generation     BIGINT       NOT NULL,
  source_revision      BIGINT       NOT NULL,
  acl_version          BIGINT       NOT NULL,
  freshness_class      TEXT         NOT NULL,
  identity_confidence  NUMERIC(4,3) NOT NULL DEFAULT 1.000,
  provisional_edges    BOOLEAN      NOT NULL DEFAULT FALSE,
  retrieved_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  tier                 TEXT         NOT NULL DEFAULT 'full',
  summary              JSONB
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kf_provenance_path_check'
  ) THEN
    ALTER TABLE oweibo.kf_provenance
      ADD CONSTRAINT kf_provenance_path_check
      CHECK (retrieval_path IN ('index','live','hybrid','cache'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kf_provenance_freshness_check'
  ) THEN
    ALTER TABLE oweibo.kf_provenance
      ADD CONSTRAINT kf_provenance_freshness_check
      CHECK (freshness_class IN ('static','operational','transactional','critical'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kf_provenance_tier_check'
  ) THEN
    ALTER TABLE oweibo.kf_provenance
      ADD CONSTRAINT kf_provenance_tier_check
      CHECK (tier IN ('full','summarized','metadata'));
  END IF;
END $$;

ALTER TABLE oweibo.kf_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.kf_provenance FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.kf_provenance;
CREATE POLICY tenant_isolation ON oweibo.kf_provenance
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.kf_provenance TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_kf_provenance_tenant_retrieval
  ON oweibo.kf_provenance (tenant_id, retrieval_id);

CREATE INDEX IF NOT EXISTS idx_kf_provenance_tenant_object
  ON oweibo.kf_provenance (tenant_id, knowledge_object_id);

DO $$
BEGIN
  RAISE NOTICE 'K.0 kf_provenance installed.';
END;
$$;
