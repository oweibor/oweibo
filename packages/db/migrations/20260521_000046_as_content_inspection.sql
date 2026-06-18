-- S.5 (ttv-action-safety-v2): pre-execution content inspection
-- and post-execution verification.
--
-- Adds:
--   * content_inspection_results       — audit log of inspector verdicts
--   * post_execution_verifications     — outcome verification + drift records
--   * deferred_verifications           — worker queue for time-deferred checks
--
-- All three tables are RLS-scoped to the owning tenant; platform_admin
-- bypasses for cross-tenant admin operations.
--
-- Pre-flight: requires ttv.md T.−1 (action_proposals + tenants).
--
-- Feature gates: feature flags `content_inspection.enabled` and
-- `post_execution_verification.enabled` (consumed by the engine).
-- Off-by-default ⇒ inspectors skipped, no rows written, byte-identical
-- to today.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'oweibo' AND table_name = 'action_proposals'
  ) THEN
    RAISE EXCEPTION 'S.5 migration requires ttv.md T.−1 (action_proposals) to be applied first.';
  END IF;
END $$;

BEGIN;

-- ── content_inspection_results ──────────────────────────────────────────
-- Append-only audit log of every inspector verdict. Multiple inspectors
-- may produce rows for the same proposal_id (one row per inspector).
CREATE TABLE IF NOT EXISTS oweibo.content_inspection_results (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  proposal_id     UUID         REFERENCES oweibo.action_proposals(id) ON DELETE CASCADE,
  action_class    TEXT         NOT NULL,
  action_id       TEXT         NOT NULL,
  inspector_name  TEXT         NOT NULL,
  verdict         TEXT         NOT NULL CHECK (verdict IN ('allow', 'upgrade_to_approval', 'forbid')),
  reason          TEXT,
  details         JSONB,
  inspected_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE oweibo.content_inspection_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.content_inspection_results FORCE ROW LEVEL SECURITY;

CREATE POLICY content_inspection_results_tenant
  ON oweibo.content_inspection_results
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY content_inspection_results_platform_admin
  ON oweibo.content_inspection_results
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT ON oweibo.content_inspection_results TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_content_inspection_proposal
  ON oweibo.content_inspection_results (proposal_id);
CREATE INDEX IF NOT EXISTS idx_content_inspection_tenant_at
  ON oweibo.content_inspection_results (tenant_id, inspected_at DESC);
-- Partial index for fast "list recent forbids" admin queries:
CREATE INDEX IF NOT EXISTS idx_content_inspection_forbid
  ON oweibo.content_inspection_results (tenant_id, action_class, inspected_at DESC)
  WHERE verdict = 'forbid';

-- ── post_execution_verifications ────────────────────────────────────────
-- Records the outcome of a verifier comparing expected vs observed state.
-- One row per verifier run; multiple rows possible per proposal_id if
-- both immediate + deferred verifiers run, or if a deferred verifier
-- retries.
CREATE TABLE IF NOT EXISTS oweibo.post_execution_verifications (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  proposal_id           UUID         REFERENCES oweibo.action_proposals(id) ON DELETE CASCADE,
  verifier_name         TEXT         NOT NULL,
  timing                TEXT         NOT NULL CHECK (timing IN ('immediate', 'deferred')),
  drift_severity        INTEGER      NOT NULL CHECK (drift_severity BETWEEN 0 AND 3),
  expected              JSONB        NOT NULL,
  observed              JSONB        NOT NULL,
  diff                  JSONB,
  observed_cost_cents   INTEGER,
  auto_rollback_invoked BOOLEAN      NOT NULL DEFAULT false,
  notes                 TEXT,
  verified_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE oweibo.post_execution_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.post_execution_verifications FORCE ROW LEVEL SECURITY;

CREATE POLICY post_exec_verifications_tenant
  ON oweibo.post_execution_verifications
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY post_exec_verifications_platform_admin
  ON oweibo.post_execution_verifications
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT ON oweibo.post_execution_verifications TO oweibo_app;

-- Drift triage: oncall queries notable + significant drift for the last 7d
CREATE INDEX IF NOT EXISTS idx_post_exec_verifications_drift
  ON oweibo.post_execution_verifications (tenant_id, drift_severity, verified_at DESC)
  WHERE drift_severity >= 2;
CREATE INDEX IF NOT EXISTS idx_post_exec_verifications_proposal
  ON oweibo.post_execution_verifications (proposal_id);

-- ── deferred_verifications ──────────────────────────────────────────────
-- Worker queue. The ApprovalLifecycleWorker (S.1) polls this table on
-- the same 30s tick; rows with state='pending' AND verify_after <= NOW()
-- are claimed via FOR UPDATE SKIP LOCKED.
CREATE TABLE IF NOT EXISTS oweibo.deferred_verifications (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  proposal_id         UUID         NOT NULL REFERENCES oweibo.action_proposals(id) ON DELETE CASCADE,
  verifier_name       TEXT         NOT NULL,
  verifier_config     JSONB        NOT NULL DEFAULT '{}',
  expected            JSONB        NOT NULL,
  verify_after        TIMESTAMPTZ  NOT NULL,
  attempts            INTEGER      NOT NULL DEFAULT 0,
  state               TEXT         NOT NULL DEFAULT 'pending'
                                    CHECK (state IN ('pending', 'running', 'done', 'failed_terminal', 'superseded')),
  last_error          TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ
);

ALTER TABLE oweibo.deferred_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.deferred_verifications FORCE ROW LEVEL SECURITY;

CREATE POLICY deferred_verifications_tenant
  ON oweibo.deferred_verifications
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY deferred_verifications_platform_admin
  ON oweibo.deferred_verifications
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE ON oweibo.deferred_verifications TO oweibo_app;

-- Partial index keyed to the worker's poll predicate. Stays tiny since
-- only 'pending' rows match; running/done/failed/superseded are excluded.
CREATE INDEX IF NOT EXISTS idx_deferred_verifications_due
  ON oweibo.deferred_verifications (verify_after)
  WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_deferred_verifications_proposal
  ON oweibo.deferred_verifications (proposal_id);

COMMIT;

DO $$
BEGIN
  RAISE NOTICE 'S.5 content inspection + post-execution verification installed.';
END;
$$;
