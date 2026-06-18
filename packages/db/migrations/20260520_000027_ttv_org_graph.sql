-- T.2.h: Tenant org graph — nodes, edges, facts, stakeholder interests.
--
-- Captures who's in the org, what teams exist, who approves what.
-- Queryable by T.−1 require_approval routing and by future alignment-
-- scoring flows so the system can reason about organisational
-- structure rather than treating every tenant as a flat user list.

-- ── oweibo.org_nodes ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.org_nodes (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  node_type    TEXT         NOT NULL,
  label        TEXT         NOT NULL,
  user_id      UUID         REFERENCES oweibo.users(id),
  external_ref TEXT,
  metadata     JSONB        NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_nodes_type_check'
  ) THEN
    ALTER TABLE oweibo.org_nodes
      ADD CONSTRAINT org_nodes_type_check
      CHECK (node_type IN ('person','team','system','decision_body','external_party'))
      NOT VALID;
    ALTER TABLE oweibo.org_nodes
      VALIDATE CONSTRAINT org_nodes_type_check;
  END IF;
END $$;

ALTER TABLE oweibo.org_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.org_nodes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON oweibo.org_nodes;
CREATE POLICY tenant_isolation ON oweibo.org_nodes
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.org_nodes TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_org_nodes_tenant_type ON oweibo.org_nodes (tenant_id, node_type);
CREATE INDEX IF NOT EXISTS idx_org_nodes_user ON oweibo.org_nodes (user_id) WHERE user_id IS NOT NULL;

-- ── oweibo.org_edges ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.org_edges (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  from_node   UUID         NOT NULL REFERENCES oweibo.org_nodes(id) ON DELETE CASCADE,
  to_node     UUID         NOT NULL REFERENCES oweibo.org_nodes(id) ON DELETE CASCADE,
  edge_type   TEXT         NOT NULL,
  metadata    JSONB        NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_edges_type_check'
  ) THEN
    ALTER TABLE oweibo.org_edges
      ADD CONSTRAINT org_edges_type_check
      CHECK (edge_type IN ('reports_to','owns','approves','depends_on','member_of','accountable_for'))
      NOT VALID;
    ALTER TABLE oweibo.org_edges
      VALIDATE CONSTRAINT org_edges_type_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_edges_unique'
  ) THEN
    ALTER TABLE oweibo.org_edges
      ADD CONSTRAINT org_edges_unique
      UNIQUE (tenant_id, from_node, to_node, edge_type);
  END IF;
END $$;

ALTER TABLE oweibo.org_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.org_edges FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON oweibo.org_edges;
CREATE POLICY tenant_isolation ON oweibo.org_edges
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.org_edges TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_org_edges_from ON oweibo.org_edges (tenant_id, from_node, edge_type);
CREATE INDEX IF NOT EXISTS idx_org_edges_to   ON oweibo.org_edges (tenant_id, to_node, edge_type);

-- ── oweibo.org_facts ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.org_facts (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  node_id    UUID         NOT NULL REFERENCES oweibo.org_nodes(id) ON DELETE CASCADE,
  fact_key   TEXT         NOT NULL,
  fact_value TEXT         NOT NULL,
  source     TEXT         NOT NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_facts_source_check'
  ) THEN
    ALTER TABLE oweibo.org_facts
      ADD CONSTRAINT org_facts_source_check
      CHECK (source IN ('admin_declared','intake_inferred','connector_sync','organic_inferred'))
      NOT VALID;
    ALTER TABLE oweibo.org_facts
      VALIDATE CONSTRAINT org_facts_source_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_facts_unique'
  ) THEN
    ALTER TABLE oweibo.org_facts
      ADD CONSTRAINT org_facts_unique
      UNIQUE (tenant_id, node_id, fact_key);
  END IF;
END $$;

ALTER TABLE oweibo.org_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.org_facts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON oweibo.org_facts;
CREATE POLICY tenant_isolation ON oweibo.org_facts
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.org_facts TO oweibo_app;

-- ── oweibo.org_stakeholder_interests ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.org_stakeholder_interests (
  id        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  node_id   UUID         NOT NULL REFERENCES oweibo.org_nodes(id) ON DELETE CASCADE,
  domain    TEXT         NOT NULL,
  weight    NUMERIC(4,3) NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_stakeholder_weight_check'
  ) THEN
    ALTER TABLE oweibo.org_stakeholder_interests
      ADD CONSTRAINT org_stakeholder_weight_check
      CHECK (weight BETWEEN 0 AND 1)
      NOT VALID;
    ALTER TABLE oweibo.org_stakeholder_interests
      VALIDATE CONSTRAINT org_stakeholder_weight_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_stakeholder_unique'
  ) THEN
    ALTER TABLE oweibo.org_stakeholder_interests
      ADD CONSTRAINT org_stakeholder_unique
      UNIQUE (tenant_id, node_id, domain);
  END IF;
END $$;

ALTER TABLE oweibo.org_stakeholder_interests ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.org_stakeholder_interests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON oweibo.org_stakeholder_interests;
CREATE POLICY tenant_isolation ON oweibo.org_stakeholder_interests
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.org_stakeholder_interests TO oweibo_app;

DO $$
BEGIN
  RAISE NOTICE 'T.2.h org-graph installed (nodes, edges, facts, stakeholder_interests).';
END;
$$;
