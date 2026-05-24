-- S.7 (ttv-action-safety-v2): forensic replay + HITL handoff.
--
-- Adds:
--   * forensic_packets    — index of built packets (body lives in S3/MinIO)
--   * action_replay_runs  — queue + audit for replay invocations
--
-- Both tables are RLS-scoped to the owning tenant; platform_admin
-- bypasses for cross-tenant compliance review.
--
-- Pre-flight: requires T.−1 (action_proposals), S.0 (action_plans).
--
-- Feature gate: `forensic_replay.enabled`. With the flag off,
-- HitlHandoffService.prepare() and ActionReplayService throw
-- not_implemented; the schema sits dormant.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'oweibo' AND table_name = 'action_plans'
  ) THEN
    RAISE EXCEPTION 'S.7 migration requires S.0 (action_plans) to be applied first.';
  END IF;
END $$;

BEGIN;

-- ── forensic_packets ────────────────────────────────────────────────────
-- The packet body itself lives in object storage (S3/MinIO); this row
-- carries the storage ref + a signature so an auditor can verify the
-- bytes haven't been altered after build.
CREATE TABLE IF NOT EXISTS oweibo.forensic_packets (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  plan_id             UUID         NOT NULL REFERENCES oweibo.action_plans(id) ON DELETE CASCADE,
  trigger_kind        TEXT         NOT NULL CHECK (trigger_kind IN (
                                       'manual', 'auto_drift', 'auto_rollback_failed',
                                       'auto_pattern', 'compliance_request'
                                     )),
  triggered_by        TEXT         NOT NULL,   -- user id (uuid string) or 'system'
  summary             TEXT,
  packet_storage_ref  TEXT         NOT NULL,   -- S3/MinIO key
  packet_signature    TEXT         NOT NULL,   -- HMAC-SHA256 of packet bytes
  packet_byte_size    INTEGER      NOT NULL DEFAULT 0 CHECK (packet_byte_size >= 0),
  state               TEXT         NOT NULL DEFAULT 'open'
                                    CHECK (state IN ('open', 'under_review', 'resolved', 'archived')),
  resolution          TEXT         CHECK (resolution IN (
                                       'resumed', 'overridden', 'aborted', 'lessons_learned'
                                     )),
  resolution_notes    TEXT,
  resolved_by         UUID         REFERENCES oweibo.users(id),
  resolved_at         TIMESTAMPTZ,
  -- HITL SLA: 24h default; after this the plan auto-aborts.
  expires_at          TIMESTAMPTZ  NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE oweibo.forensic_packets ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.forensic_packets FORCE ROW LEVEL SECURITY;

CREATE POLICY forensic_packets_tenant
  ON oweibo.forensic_packets
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY forensic_packets_platform_admin
  ON oweibo.forensic_packets
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE ON oweibo.forensic_packets TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_forensic_packets_plan
  ON oweibo.forensic_packets (plan_id);
CREATE INDEX IF NOT EXISTS idx_forensic_packets_open
  ON oweibo.forensic_packets (tenant_id, created_at DESC)
  WHERE state IN ('open', 'under_review');

-- ── action_replay_runs ──────────────────────────────────────────────────
-- Replays NEVER invoke real adapter execute() — the runner uses a
-- separate code path that only walks preflight + verifier paths.
-- Status transitions: queued → running → complete | failed.
CREATE TABLE IF NOT EXISTS oweibo.action_replay_runs (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  plan_id         UUID         NOT NULL REFERENCES oweibo.action_plans(id),
  requested_by    UUID         NOT NULL REFERENCES oweibo.users(id),
  replay_kind     TEXT         NOT NULL
                    CHECK (replay_kind IN ('shadow_full', 'shadow_step', 'what_if')),
  mutation        JSONB,                          -- for what_if only
  result_summary  JSONB,
  status          TEXT         NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'complete', 'failed')),
  failure_reason  TEXT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE oweibo.action_replay_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.action_replay_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY action_replay_runs_tenant
  ON oweibo.action_replay_runs
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY action_replay_runs_platform_admin
  ON oweibo.action_replay_runs
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE ON oweibo.action_replay_runs TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_action_replay_runs_plan
  ON oweibo.action_replay_runs (plan_id, created_at DESC);

COMMIT;

DO $$
BEGIN
  RAISE NOTICE 'S.7 forensic replay + HITL handoff installed.';
END;
$$;
