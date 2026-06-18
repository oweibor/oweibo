-- D.2 (domain-depth): task_rubric_evaluations — one row per (task,
-- rubric) evaluation. Generic rubrics use NULL domain_slug; per-domain
-- rubrics carry the slug for cross-cuts in admin reporting.
--
-- `blocked` is stored separately from `score` so an auditor reading the
-- row never has to reconcile "why does this failed task have score=0.92?"
-- — the blocked flag is the answer and the dashboard renders
-- "Failed (score N/A)" when set, regardless of the numeric score.

CREATE TABLE IF NOT EXISTS oweibo.task_rubric_evaluations (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  task_id           UUID         NOT NULL,
  rubric_id         TEXT         NOT NULL,
  domain_slug       TEXT         REFERENCES oweibo.domain_catalog(slug),
  rubric_version    TEXT         NOT NULL,
  score             NUMERIC(4,3) CHECK (score IS NULL OR (score BETWEEN 0 AND 1)),
  blocked           BOOLEAN      NOT NULL DEFAULT false,
  criterion_results JSONB        NOT NULL DEFAULT '[]',
  enforced          BOOLEAN      NOT NULL DEFAULT false,
  evaluated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE oweibo.task_rubric_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.task_rubric_evaluations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.task_rubric_evaluations;
CREATE POLICY tenant_isolation ON oweibo.task_rubric_evaluations
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT ON oweibo.task_rubric_evaluations TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_task_rubric_evaluations_task
  ON oweibo.task_rubric_evaluations (task_id);
CREATE INDEX IF NOT EXISTS idx_task_rubric_evaluations_domain
  ON oweibo.task_rubric_evaluations (domain_slug, evaluated_at DESC)
  WHERE domain_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_rubric_evaluations_blocked
  ON oweibo.task_rubric_evaluations (tenant_id, evaluated_at DESC)
  WHERE blocked = true;

DO $$
BEGIN
  RAISE NOTICE 'D.2 task_rubric_evaluations installed.';
END;
$$;
