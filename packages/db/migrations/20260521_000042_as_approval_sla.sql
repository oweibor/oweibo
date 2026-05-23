-- S.1 (ttv-action-safety-v2): Approval SLA policies, FSM state, notifications.
--
-- Four new tables:
--   1. approval_sla_policies — per-tenant per-class policy
--   2. approval_sla_state — one row per pending require_approval proposal;
--      drives the ApprovalLifecycleWorker FSM
--   3. notification_dispatch_log — audit trail of every dispatched message
--   4. in_app_notifications — bell-icon feed for the admin-web UI
--
-- Pre-flight: requires ttv.md T.−1 (action_proposals).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'oweibo' AND table_name = 'action_proposals'
  ) THEN
    RAISE EXCEPTION 'S.1 migration requires ttv.md T.−1 (action_proposals) to be applied first.';
  END IF;
END $$;

BEGIN;

-- ── approval_sla_policies ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oweibo.approval_sla_policies (
  id                            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                     UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  action_class                  TEXT         NOT NULL,
  initial_notify_after_seconds  INTEGER      NOT NULL CHECK (initial_notify_after_seconds >= 0),
  escalate_after_seconds        INTEGER[]    NOT NULL DEFAULT '{}',
  hard_expire_after_seconds     INTEGER      NOT NULL CHECK (hard_expire_after_seconds > 0),
  approver_resolution           TEXT         NOT NULL
                                              CHECK (approver_resolution IN ('org_graph','role_based','explicit_list')),
  approver_config               JSONB        NOT NULL DEFAULT '{}',
  notification_channels         JSONB        NOT NULL DEFAULT '[]',
  quiet_hours                   JSONB,
  created_by                    UUID,
  created_at                    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, action_class)
);

ALTER TABLE oweibo.approval_sla_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.approval_sla_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY approval_sla_policies_tenant
  ON oweibo.approval_sla_policies
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY approval_sla_policies_platform_admin
  ON oweibo.approval_sla_policies
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.approval_sla_policies TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_approval_sla_policies_tenant
  ON oweibo.approval_sla_policies (tenant_id, action_class);

-- ── approval_sla_state ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oweibo.approval_sla_state (
  proposal_id               UUID         PRIMARY KEY REFERENCES oweibo.action_proposals(id) ON DELETE CASCADE,
  tenant_id                 UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  policy_id                 UUID         REFERENCES oweibo.approval_sla_policies(id),
  current_stage             INTEGER      NOT NULL DEFAULT 0,
  next_action_at            TIMESTAMPTZ  NOT NULL,
  hard_expire_at            TIMESTAMPTZ  NOT NULL,
  notified_approvers        UUID[]       NOT NULL DEFAULT '{}',
  escalation_count          INTEGER      NOT NULL DEFAULT 0,
  last_notification_at      TIMESTAMPTZ,
  last_notification_details JSONB,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT approval_sla_state_stage_nonneg CHECK (current_stage >= 0)
);

ALTER TABLE oweibo.approval_sla_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.approval_sla_state FORCE ROW LEVEL SECURITY;

CREATE POLICY approval_sla_state_tenant
  ON oweibo.approval_sla_state
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY approval_sla_state_platform_admin
  ON oweibo.approval_sla_state
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.approval_sla_state TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_approval_sla_state_next
  ON oweibo.approval_sla_state (next_action_at);

-- ── notification_dispatch_log ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oweibo.notification_dispatch_log (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  proposal_id     UUID         REFERENCES oweibo.action_proposals(id),
  channel_kind    TEXT         NOT NULL CHECK (channel_kind IN ('slack','email','webhook','in_app')),
  recipient       TEXT         NOT NULL,
  fire_event      TEXT         NOT NULL,
  delivery_status TEXT         NOT NULL CHECK (delivery_status IN
                                                ('queued','sent','delivered','failed','suppressed_quiet_hours')),
  attempt_count   INTEGER      NOT NULL DEFAULT 0,
  last_error      TEXT,
  dispatched_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE oweibo.notification_dispatch_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.notification_dispatch_log FORCE ROW LEVEL SECURITY;

CREATE POLICY notification_dispatch_log_tenant
  ON oweibo.notification_dispatch_log
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY notification_dispatch_log_platform_admin
  ON oweibo.notification_dispatch_log
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE ON oweibo.notification_dispatch_log TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_notification_dispatch_proposal
  ON oweibo.notification_dispatch_log (proposal_id, created_at DESC);

-- ── in_app_notifications (bell-icon feed) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS oweibo.in_app_notifications (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  recipient_user_id UUID     NOT NULL,
  proposal_id   UUID         REFERENCES oweibo.action_proposals(id),
  title         TEXT         NOT NULL,
  body          TEXT,
  link_path     TEXT,
  unread        BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  read_at       TIMESTAMPTZ
);

ALTER TABLE oweibo.in_app_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.in_app_notifications FORCE ROW LEVEL SECURITY;

CREATE POLICY in_app_notifications_tenant
  ON oweibo.in_app_notifications
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY in_app_notifications_platform_admin
  ON oweibo.in_app_notifications
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE ON oweibo.in_app_notifications TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_in_app_notifications_recipient
  ON oweibo.in_app_notifications (tenant_id, recipient_user_id, created_at DESC)
  WHERE unread = true;

COMMIT;

DO $$
BEGIN
  RAISE NOTICE 'S.1 approval SLA + notifications installed.';
END;
$$;
