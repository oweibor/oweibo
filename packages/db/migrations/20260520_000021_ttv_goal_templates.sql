-- T.2.d: Platform-curated goal templates.
--
-- Cross-tenant catalog (no tenant_id). Tenants read; only platform_admin
-- writes. GoalDecomposer consults IGoalTemplateMatcher before running the
-- LLM — a similarity match >= 0.78 produces a pre-baked sub-goal skeleton
-- that seeds the LLM rather than expecting it to decompose from scratch.
--
-- Embedding column: pgvector if available (single round-trip ANN search);
-- BYTEA fallback if not (in-process cosine after a small SELECT). Both
-- paths must return byte-identical top-K rankings — a conformance test
-- in CI pins parity.

CREATE TABLE IF NOT EXISTS oweibo.goal_templates (
  template_id        TEXT         PRIMARY KEY,
  catalog_version    TEXT         NOT NULL,
  trigger_summary    TEXT         NOT NULL,
  sub_goal_skeleton  JSONB        NOT NULL,
  industries         TEXT[]       NOT NULL DEFAULT '{}',
  templates          TEXT[]       NOT NULL DEFAULT ARRAY['*']::TEXT[],
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── pgvector detection: add the appropriate embedding column ──────────────
DO $$
DECLARE has_pgvector BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'vector'
  ) INTO has_pgvector;

  IF has_pgvector THEN
    EXECUTE 'ALTER TABLE oweibo.goal_templates
               ADD COLUMN IF NOT EXISTS trigger_embedding VECTOR(1536)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_goal_templates_embedding
               ON oweibo.goal_templates USING ivfflat (trigger_embedding vector_cosine_ops)';
    RAISE NOTICE 'T.2.d: pgvector detected — VECTOR(1536) column installed.';
  ELSE
    EXECUTE 'ALTER TABLE oweibo.goal_templates
               ADD COLUMN IF NOT EXISTS trigger_embedding_bytes BYTEA';
    RAISE NOTICE 'T.2.d: pgvector NOT detected — BYTEA fallback column installed.';
  END IF;
END $$;

ALTER TABLE oweibo.goal_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.goal_templates FORCE ROW LEVEL SECURITY;

-- Read is public to any tenant; writes are restricted to platform_admin.
-- The RLS policy on platform-admin writes uses the same convention as other
-- cross-tenant catalogs in the schema (current_user = 'platform_admin' is
-- granted BYPASSRLS via withTenantContext's SET LOCAL ROLE).
DROP POLICY IF EXISTS read_any ON oweibo.goal_templates;
CREATE POLICY read_any ON oweibo.goal_templates FOR SELECT USING (true);

GRANT SELECT ON oweibo.goal_templates TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_goal_templates_industries
  ON oweibo.goal_templates USING gin (industries);

CREATE INDEX IF NOT EXISTS idx_goal_templates_templates
  ON oweibo.goal_templates USING gin (templates);

DO $$
BEGIN
  RAISE NOTICE 'T.2.d goal-templates catalog installed.';
END;
$$;
