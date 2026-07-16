-- K.8 (ADR-002 Identity Resolution, ratified 2026-07-13): the identity +
-- knowledge-graph stores. This replaces the Experimental cross-source seed
-- posture kf_principal_seeds reserved for "Identity Resolution's (ADR-002,
-- K.8)" — canonical_id, confidence, resolution state, and merge decisions
-- live HERE, not in the raw per-source seed store.
--
-- Three tenant-scoped tables (ADR-000 §3.4: FORCE RLS + tenant_isolation;
-- each enters the kf-store-scope manifest):
--   1. kf_canonical_identities — the canonical person record (§3.1)
--   2. kf_identity_links       — source principal → canonical id + confidence
--                                + state + signals (§3.1/§3.2/§3.3)
--   3. kf_graph_edges          — the knowledge graph (§3.6); edges tagged with
--                                index_generation + source_revision (§8.2,
--                                INV-1) and confidence (provisional/resolved),
--                                with a state (active/pending/retracted) for
--                                the pending-edge rule (ADR-003) and async
--                                GraphInvalidated retraction (§3.5).
--
-- Sole writer (ADR-000 §3.6 map): Identity Resolution owns 1 & 2, the
-- Knowledge Graph owns 3 — both Knowledge-Runtime components. Identity is
-- NEVER a permission input (§3.7): these tables feed ranking + cache key +
-- hedging, never an ACL decision.

-- ── 1. canonical identities ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oweibo.kf_canonical_identities (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  primary_email  TEXT,
  display_name   TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kf_canonical_identities_email
  ON oweibo.kf_canonical_identities (tenant_id, primary_email)
  WHERE primary_email IS NOT NULL;

-- ── 2. identity links (source principal → canonical, with confidence/state) ─
CREATE TABLE IF NOT EXISTS oweibo.kf_identity_links (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  canonical_id         UUID         NOT NULL REFERENCES oweibo.kf_canonical_identities(id) ON DELETE CASCADE,
  source               TEXT         NOT NULL,
  source_principal_ref TEXT         NOT NULL,
  confidence           NUMERIC(4,3) NOT NULL DEFAULT 0,
  state                TEXT         NOT NULL DEFAULT 'unresolved',
  signals              JSONB        NOT NULL DEFAULT '[]'::jsonb,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kf_identity_links_unique_principal') THEN
    ALTER TABLE oweibo.kf_identity_links
      ADD CONSTRAINT kf_identity_links_unique_principal
      UNIQUE (tenant_id, source, source_principal_ref);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kf_identity_links_state_check') THEN
    ALTER TABLE oweibo.kf_identity_links
      ADD CONSTRAINT kf_identity_links_state_check
      CHECK (state IN ('resolved', 'provisional', 'unresolved'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_kf_identity_links_canonical
  ON oweibo.kf_identity_links (tenant_id, canonical_id);
CREATE INDEX IF NOT EXISTS idx_kf_identity_links_state
  ON oweibo.kf_identity_links (tenant_id, state);

-- ── 3. knowledge graph edges ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oweibo.kf_graph_edges (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  src_kind          TEXT         NOT NULL,
  src_ref           TEXT         NOT NULL,
  edge_type         TEXT         NOT NULL,
  dst_kind          TEXT         NOT NULL,
  dst_ref           TEXT         NOT NULL,
  source            TEXT         NOT NULL,
  confidence        TEXT         NOT NULL DEFAULT 'resolved',
  state             TEXT         NOT NULL DEFAULT 'active',
  index_generation  BIGINT       NOT NULL DEFAULT 0,
  source_revision   BIGINT       NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kf_graph_edges_unique') THEN
    ALTER TABLE oweibo.kf_graph_edges
      ADD CONSTRAINT kf_graph_edges_unique
      UNIQUE (tenant_id, src_ref, edge_type, dst_ref, source);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kf_graph_edges_state_check') THEN
    ALTER TABLE oweibo.kf_graph_edges
      ADD CONSTRAINT kf_graph_edges_state_check
      CHECK (state IN ('active', 'pending', 'retracted'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kf_graph_edges_confidence_check') THEN
    ALTER TABLE oweibo.kf_graph_edges
      ADD CONSTRAINT kf_graph_edges_confidence_check
      CHECK (confidence IN ('resolved', 'provisional'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_kf_graph_edges_src ON oweibo.kf_graph_edges (tenant_id, src_ref, edge_type) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS idx_kf_graph_edges_dst ON oweibo.kf_graph_edges (tenant_id, dst_ref, edge_type) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS idx_kf_graph_edges_pending ON oweibo.kf_graph_edges (tenant_id, dst_ref) WHERE state = 'pending';

-- ── RLS: all three tenant-scoped (ADR-000 §3.4) ─────────────────────────────
ALTER TABLE oweibo.kf_canonical_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.kf_canonical_identities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON oweibo.kf_canonical_identities;
CREATE POLICY tenant_isolation ON oweibo.kf_canonical_identities
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.kf_canonical_identities TO oweibo_app;

ALTER TABLE oweibo.kf_identity_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.kf_identity_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON oweibo.kf_identity_links;
CREATE POLICY tenant_isolation ON oweibo.kf_identity_links
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.kf_identity_links TO oweibo_app;

ALTER TABLE oweibo.kf_graph_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.kf_graph_edges FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON oweibo.kf_graph_edges;
CREATE POLICY tenant_isolation ON oweibo.kf_graph_edges
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.kf_graph_edges TO oweibo_app;

DO $$
BEGIN
  RAISE NOTICE 'K.8 kf_canonical_identities + kf_identity_links + kf_graph_edges installed.';
END;
$$;
