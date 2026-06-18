-- S.3 (ttv-action-safety-v2): rollback execution framework.
--
-- Extends action_proposals.state to include rolled_back / rollback_failed,
-- and adds a rollback_executions audit table tracking adapter invocations.
--
-- Pre-flight: requires ttv.md T.−1 (action_proposals).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'oweibo' AND table_name = 'action_proposals'
  ) THEN
    RAISE EXCEPTION 'S.3 migration requires ttv.md T.−1 (action_proposals) to be applied first.';
  END IF;
END $$;

BEGIN;

-- ── action_proposals state extension ──────────────────────────────────────
-- Drop the existing constraint (created in T.−1) and replace with the
-- extended set. NOT VALID + VALIDATE keeps the rewrite cheap; the new
-- constraint is a strict superset of the old so VALIDATE never fails.
ALTER TABLE oweibo.action_proposals
  DROP CONSTRAINT IF EXISTS action_proposals_state_check;

ALTER TABLE oweibo.action_proposals
  ADD CONSTRAINT action_proposals_state_check
  CHECK (state IN (
    'pending', 'promoted', 'rejected', 'expired',
    'executed_shadow', 'executed_live',
    'rolled_back', 'rollback_failed'
  ))
  NOT VALID;
ALTER TABLE oweibo.action_proposals
  VALIDATE CONSTRAINT action_proposals_state_check;

-- ── rollback_executions ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oweibo.rollback_executions (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  original_action_id UUID         NOT NULL REFERENCES oweibo.action_proposals(id),
  recovery_action_id UUID         REFERENCES oweibo.action_proposals(id),
  adapter_name       TEXT         NOT NULL,
  reason             TEXT         NOT NULL,
  invoked_by_type    TEXT         NOT NULL
                                   CHECK (invoked_by_type IN ('agent', 'human', 'auto_drift_detection')),
  invoked_by_id      TEXT         NOT NULL,
  result_state       TEXT         CHECK (result_state IN
                                          ('fully_reverted', 'partial', 'no_op_already_reverted', 'failed')),
  result_details     TEXT,
  side_effects       TEXT[]       NOT NULL DEFAULT '{}',
  cost_usd_cents     INTEGER      NOT NULL DEFAULT 0,
  started_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at       TIMESTAMPTZ
);

ALTER TABLE oweibo.rollback_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.rollback_executions FORCE ROW LEVEL SECURITY;

CREATE POLICY rollback_executions_tenant
  ON oweibo.rollback_executions
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY rollback_executions_platform_admin
  ON oweibo.rollback_executions
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE ON oweibo.rollback_executions TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_rollback_executions_original
  ON oweibo.rollback_executions (original_action_id);
CREATE INDEX IF NOT EXISTS idx_rollback_executions_tenant_started
  ON oweibo.rollback_executions (tenant_id, started_at DESC);

COMMIT;

DO $$
BEGIN
  RAISE NOTICE 'S.3 rollback_executions installed; action_proposals state extended.';
END;
$$;
