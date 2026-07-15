-- K.9 / ADR-004 §3.7 — connector software upgrade rollout (armed).
--
-- Two changes, both ADDITIVE (ADR-000: kf_jobs evolves by additive columns
-- only; a destructive rewrite is out of spec):
--
--  1. kf_jobs.connector_version — the blue/green tag. A job carries the
--     connector version that must process it; a worker at a different version
--     never claims it, so in-flight work never crosses versions. NULLable:
--     jobs queued before this column existed are legacy/untagged and any
--     worker may process them (the migration must not strand queued work).
--
--  2. kf_connector_deployments — per-(tenant, connector) rollout state, the
--     sole record of which version serves a tenant and whether a canary or
--     rollback is in flight. Sole writer (INV-16): ConnectorUpgradeService.
--
-- Store scope: TENANT-SCOPED. FORCE RLS + tenant_isolation.

BEGIN;

-- 1. Additive blue/green tag on the job queue.
ALTER TABLE oweibo.kf_jobs
  ADD COLUMN IF NOT EXISTS connector_version TEXT;

-- Claim path can filter on version cheaply during a rollout.
CREATE INDEX IF NOT EXISTS idx_kf_jobs_connector_version
  ON oweibo.kf_jobs (connector_id, connector_version)
  WHERE state = 'queued';

-- 2. Rollout state per tenant-connector.
CREATE TABLE IF NOT EXISTS oweibo.kf_connector_deployments (
  tenant_id       UUID        NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  connector_id    TEXT        NOT NULL,
  active_version  TEXT        NOT NULL,
  target_version  TEXT,
  state           TEXT        NOT NULL DEFAULT 'stable',
  tenant_cohort   TEXT        NOT NULL DEFAULT 'stable-v0',
  canary_cohort   TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, connector_id),
  CONSTRAINT kf_connector_deployments_state_check
    CHECK (state IN ('stable', 'canary', 'rolling_back')),
  -- A rollout in flight must name the version it targets.
  CONSTRAINT kf_connector_deployments_target_present
    CHECK (state = 'stable' OR target_version IS NOT NULL)
);

ALTER TABLE oweibo.kf_connector_deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.kf_connector_deployments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.kf_connector_deployments;
CREATE POLICY tenant_isolation ON oweibo.kf_connector_deployments
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS kf_connector_deployments_platform_admin ON oweibo.kf_connector_deployments;
CREATE POLICY kf_connector_deployments_platform_admin ON oweibo.kf_connector_deployments
  FOR ALL USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.kf_connector_deployments TO oweibo_app;

COMMIT;
