-- T.2.a: per-tenant seed feedback for the suppression loop.
--
-- Depends on: 20260520_000020_ttv_provisioning_hooks.sql (oweibo.tenants).
--
-- When TaskFeedback signal='thumbs_down' is recorded, a follow-up worker
-- tallies which seed memories were recalled in the failing task's warm
-- block. The counters live here; once down_count crosses the suppression
-- threshold, the worker sets suppressed=true and tags the corresponding
-- Qdrant entry with seed:suppressed:<reason>. MemoryWarmer filters out
-- entries carrying that tag before the final slice.
--
-- Backwards compatibility: the table is purely additive. With T.2.a's
-- feature flag off, SeedMemoriesStep never writes seed entries; no rows
-- in this table; recall behavior is byte-identical to today.

CREATE TABLE IF NOT EXISTS oweibo.tenant_seed_feedback (
  tenant_id    UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  seed_id      TEXT         NOT NULL,
  down_count   INTEGER      NOT NULL DEFAULT 0,
  up_count     INTEGER      NOT NULL DEFAULT 0,
  suppressed   BOOLEAN      NOT NULL DEFAULT false,
  last_updated TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, seed_id)
);

ALTER TABLE oweibo.tenant_seed_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.tenant_seed_feedback FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.tenant_seed_feedback;
CREATE POLICY tenant_isolation ON oweibo.tenant_seed_feedback
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE ON oweibo.tenant_seed_feedback TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_tenant_seed_feedback_suppressed
  ON oweibo.tenant_seed_feedback (tenant_id)
  WHERE suppressed = true;

DO $$
BEGIN
  RAISE NOTICE 'T.2.a seed-feedback table installed.';
END;
$$;
