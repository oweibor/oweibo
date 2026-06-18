-- Audit fixes round 3 (2026-05-27) — high-severity findings + deferred items.
--
-- Adds:
--   * S.3: action_proposals.is_rollback (BOOLEAN) — distinguishes recovery
--          proposals from regular ones; lets ApprovalSlaService apply a
--          tighter SLA for rollback approvals without fragile string
--          matching on `recovery.rollback.*`.
--   * T.2.f: tenant_connectors.credential_expires_at + credential_invalid
--          state. A `credential_invalid` status surfaces failed smoke tests
--          and expired-but-not-rotated credentials to the admin UI; an
--          expires_at column drives expiry notifications.
--   * T.2.f: revoked_connector_credentials table — pub/sub is best-effort;
--          a new CredentialResolver instance MUST check this table on
--          cache miss before serving Vault data, preventing the TOCTOU
--          window where a freshly-started pod hydrates revoked secrets.
--   * S.1: notification_digest_queue table — backs the "≤1 notification
--          per 5min per recipient unless urgent" mitigation that S.1's
--          risk register lists but never schematized.
--
-- Pre-flight: requires T.−1 (action_proposals), T.2.f (tenant_connectors),
-- and S.1 (notification_dispatch_log).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'oweibo' AND table_name = 'action_proposals'
  ) THEN
    RAISE EXCEPTION 'audit-fixes round 3 requires T.−1 (action_proposals) to be applied first.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'oweibo' AND table_name = 'tenant_connectors'
  ) THEN
    RAISE EXCEPTION 'audit-fixes round 3 requires T.2.f (tenant_connectors) to be applied first.';
  END IF;
END $$;

BEGIN;

-- ── S.3: action_proposals.is_rollback ───────────────────────────────────
-- BOOLEAN NOT NULL DEFAULT false. Existing rows default to false (correct).
-- The orchestrator sets this true when creating a recovery proposal so
-- ApprovalSlaService can key the tightened SLA off this column rather
-- than substring-matching action_class.
ALTER TABLE oweibo.action_proposals
  ADD COLUMN IF NOT EXISTS is_rollback BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_action_proposals_rollback_pending
  ON oweibo.action_proposals (tenant_id, created_at DESC)
  WHERE is_rollback = true AND state = 'pending';

-- ── T.2.f: credential lifecycle columns + statuses ─────────────────────
-- Drop and re-add the status check constraint to widen the enum.
ALTER TABLE oweibo.tenant_connectors
  DROP CONSTRAINT IF EXISTS tenant_connectors_status_check;
ALTER TABLE oweibo.tenant_connectors
  ADD CONSTRAINT tenant_connectors_status_check
  CHECK (status IN (
    'pending',
    'active',
    'suspended',
    'revoked',
    -- Audit-fix (T.2.f): explicit terminal states for failed credential
    -- handling. The admin UI surfaces these with an actionable error
    -- and a "re-enter credentials" workflow.
    'credential_invalid',
    'credential_expired'
  ));

ALTER TABLE oweibo.tenant_connectors
  ADD COLUMN IF NOT EXISTS credential_expires_at TIMESTAMPTZ;
ALTER TABLE oweibo.tenant_connectors
  ADD COLUMN IF NOT EXISTS smoke_test_failure_reason TEXT;
ALTER TABLE oweibo.tenant_connectors
  ADD COLUMN IF NOT EXISTS expiry_notification_sent_at TIMESTAMPTZ;

-- Partial index for the nightly "expiring soon" sweep.
CREATE INDEX IF NOT EXISTS idx_tenant_connectors_expiring
  ON oweibo.tenant_connectors (credential_expires_at)
  WHERE status = 'active' AND credential_expires_at IS NOT NULL;

-- ── T.2.f: revocation registry ─────────────────────────────────────────
-- The audit's TOCTOU concern: pub/sub revocation broadcasts only reach
-- live subscribers. A new CredentialResolver instance starting *after*
-- a revocation message will hydrate its cache from Vault on first miss
-- and serve the revoked credential for up to one TTL (60s) before its
-- own first invalidation arrives. Fix: every cache miss consults this
-- table BEFORE serving; pub/sub remains the fast-path invalidation for
-- already-running instances.
CREATE TABLE IF NOT EXISTS oweibo.revoked_connector_credentials (
  vault_path      TEXT         PRIMARY KEY,
  tenant_id       UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  connector_id    UUID         NOT NULL REFERENCES oweibo.tenant_connectors(id) ON DELETE CASCADE,
  revoked_by      UUID,
  reason          TEXT,
  revoked_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- After this timestamp the row can be pruned (rotated credentials are
  -- unreachable anyway). Defaults to 30 days after revocation — long
  -- enough that any straggling cache is well past its TTL.
  expires_at      TIMESTAMPTZ  NOT NULL DEFAULT (NOW() + INTERVAL '30 days')
);

ALTER TABLE oweibo.revoked_connector_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.revoked_connector_credentials FORCE ROW LEVEL SECURITY;

CREATE POLICY revoked_connector_credentials_tenant
  ON oweibo.revoked_connector_credentials
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY revoked_connector_credentials_platform_admin
  ON oweibo.revoked_connector_credentials
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, DELETE ON oweibo.revoked_connector_credentials TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_revoked_creds_tenant
  ON oweibo.revoked_connector_credentials (tenant_id, revoked_at DESC);

-- ── S.1: notification digest queue ─────────────────────────────────────
-- Backs the "bundle ≤1 notification per 5min per recipient unless urgent"
-- mitigation. The lifecycle worker enqueues here when a non-urgent fire
-- event would otherwise dispatch immediately; a flush handler sweeps the
-- queue on each tick and dispatches one bundled notification per
-- (tenant, recipient, channel) where the oldest pending entry has been
-- waiting >= digest_interval_seconds.
CREATE TABLE IF NOT EXISTS oweibo.notification_digest_queue (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  proposal_id        UUID         REFERENCES oweibo.action_proposals(id) ON DELETE CASCADE,
  recipient_user_id  UUID         NOT NULL,
  channel_kind       TEXT         NOT NULL CHECK (channel_kind IN ('slack', 'email', 'webhook', 'in_app')),
  fire_event         TEXT         NOT NULL,
  title              TEXT         NOT NULL,
  body               TEXT,
  link_path          TEXT,
  urgency            TEXT         NOT NULL DEFAULT 'normal' CHECK (urgency IN ('normal', 'urgent')),
  state              TEXT         NOT NULL DEFAULT 'pending'
                                    CHECK (state IN ('pending', 'flushed', 'cancelled')),
  enqueued_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  flushed_at         TIMESTAMPTZ
);

ALTER TABLE oweibo.notification_digest_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.notification_digest_queue FORCE ROW LEVEL SECURITY;

CREATE POLICY notification_digest_queue_tenant
  ON oweibo.notification_digest_queue
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY notification_digest_queue_platform_admin
  ON oweibo.notification_digest_queue
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE ON oweibo.notification_digest_queue TO oweibo_app;

-- Worker poll predicate: pending rows for a given recipient older than
-- the digest interval. Partial index keyed off `state = 'pending'`
-- keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_notification_digest_pending
  ON oweibo.notification_digest_queue (recipient_user_id, channel_kind, enqueued_at ASC)
  WHERE state = 'pending';

COMMIT;

DO $$
BEGIN
  RAISE NOTICE 'Audit fixes round 3 applied: is_rollback, credential lifecycle, revocation registry, notification digest.';
END;
$$;
