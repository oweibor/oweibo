-- K.3 (ADR-003 full, ratified 2026-07-12): chunk content + Postgres FTS.
--
-- The roadmap's K.3 deliverable is "metadata + structural indexing into
-- Postgres FTS (no embeddings yet)". The K.0 chunk table stored spans and
-- hashes but no text — additive columns only:
--
--   content  — the chunk's text (metadata-depth fields are small; the
--              chunk-diff rule (ADR-003 §3.5) keys on chunk_hash, which
--              is the sha256 of exactly this value)
--   fts      — generated tsvector over content, GIN-indexed; the K.3
--              retrieval path queries THIS, never LIKE-scans
--
-- Sole writer unchanged: Knowledge Runtime / Indexing Service.

ALTER TABLE oweibo.kf_chunks
  ADD COLUMN IF NOT EXISTS content TEXT NOT NULL DEFAULT '';

-- Generated column + GIN index (idempotent guards; ADD COLUMN ... GENERATED
-- has no IF NOT EXISTS for the generation clause on older PG, so guard via
-- catalog check).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'oweibo' AND table_name = 'kf_chunks' AND column_name = 'fts'
  ) THEN
    ALTER TABLE oweibo.kf_chunks
      ADD COLUMN fts tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_kf_chunks_fts ON oweibo.kf_chunks USING GIN (fts);

DO $$
BEGIN
  RAISE NOTICE 'K.3 kf_chunks content + FTS installed.';
END;
$$;
