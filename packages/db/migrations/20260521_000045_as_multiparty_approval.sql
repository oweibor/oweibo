-- S.4 (ttv-action-safety-v2): multi-party + time-windowed approvals.
--
-- Adds:
--   * multi_party_approval_policies   — per-(tenant, action_class) quorum config
--   * approval_votes                  — N-of-M per-proposal vote ledger
--   * time_windowed_grants            — bounded "approve class X for N actions / D seconds"
--   * approval_delegations            — bounded "user A delegates approvals for class X to user B"
--
-- All four tables are RLS-scoped to the owning tenant; platform_admin role
-- bypasses for cross-tenant admin operations.
--
-- Pre-flight: requires ttv.md T.−1 (action_proposals + tenants) and the
-- canonical oweibo.users table.
--
-- Feature gate: feature flag `multi_party_approval.enabled` (consumed by the
-- service layer). With the flag off, single-approver behavior is preserved
-- and the time_windowed_grants / approval_votes tables are simply not read,
-- which is byte-identical to today.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'oweibo' AND table_name = 'action_proposals'
  ) THEN
    RAISE EXCEPTION 'S.4 migration requires ttv.md T.−1 (action_proposals) to be applied first.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'oweibo' AND table_name = 'users'
  ) THEN
    RAISE EXCEPTION 'S.4 migration requires oweibo.users to exist.';
  END IF;
END $$;

BEGIN;

-- ── multi_party_approval_policies ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oweibo.multi_party_approval_policies (
  tenant_id                   UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  action_class                TEXT         NOT NULL,
  quorum                      INTEGER      NOT NULL DEFAULT 1
                                            CHECK (quorum >= 1 AND quorum <= 10),
  dissent_vetoes              BOOLEAN      NOT NULL DEFAULT true,
  allow_grants                BOOLEAN      NOT NULL DEFAULT false,
  max_grant_duration_seconds  INTEGER      NOT NULL DEFAULT 86400
                                            CHECK (max_grant_duration_seconds > 0),
  max_grant_action_count      INTEGER      NOT NULL DEFAULT 100
                                            CHECK (max_grant_action_count > 0),
  allow_delegation            BOOLEAN      NOT NULL DEFAULT true,
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, action_class)
);

ALTER TABLE oweibo.multi_party_approval_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.multi_party_approval_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY multi_party_approval_policies_tenant
  ON oweibo.multi_party_approval_policies
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY multi_party_approval_policies_platform_admin
  ON oweibo.multi_party_approval_policies
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.multi_party_approval_policies TO oweibo_app;

-- ── approval_votes ───────────────────────────────────────────────────────
-- Append-only per-(proposal, voter) vote ledger. Quorum service tallies
-- approvals/rejections from this table; a re-vote by the same user is
-- prevented by the composite PK (the UI surfaces "change vote" as a
-- DELETE-then-INSERT or as a separate audit-tracked operation).
CREATE TABLE IF NOT EXISTS oweibo.approval_votes (
  proposal_id    UUID         NOT NULL REFERENCES oweibo.action_proposals(id) ON DELETE CASCADE,
  voter_user_id  UUID         NOT NULL REFERENCES oweibo.users(id),
  tenant_id      UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  vote           TEXT         NOT NULL CHECK (vote IN ('approve', 'reject')),
  comment        TEXT,
  via_delegation BOOLEAN      NOT NULL DEFAULT false,
  delegator_user_id UUID      REFERENCES oweibo.users(id),
  voted_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (proposal_id, voter_user_id)
);

ALTER TABLE oweibo.approval_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.approval_votes FORCE ROW LEVEL SECURITY;

CREATE POLICY approval_votes_tenant
  ON oweibo.approval_votes
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY approval_votes_platform_admin
  ON oweibo.approval_votes
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, DELETE ON oweibo.approval_votes TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_approval_votes_proposal
  ON oweibo.approval_votes (proposal_id, vote);

-- ── time_windowed_grants ─────────────────────────────────────────────────
-- A grant covers an (action_class, optional scope_filter) for a bounded
-- time window and use count. The trust ladder consults this table BEFORE
-- returning require_approval; an active matching grant downgrades the
-- decision to execute and increments `uses` atomically.
CREATE TABLE IF NOT EXISTS oweibo.time_windowed_grants (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  action_class          TEXT         NOT NULL,
  granted_by_user_ids   UUID[]       NOT NULL CHECK (cardinality(granted_by_user_ids) >= 1),
  granted_to_kind       TEXT         NOT NULL CHECK (granted_to_kind IN ('agent', 'user')),
  granted_to_user_id    UUID         REFERENCES oweibo.users(id),
  scope_filter          JSONB,
  expires_at            TIMESTAMPTZ  NOT NULL,
  max_uses              INTEGER      NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  uses                  INTEGER      NOT NULL DEFAULT 0 CHECK (uses >= 0),
  state                 TEXT         NOT NULL DEFAULT 'active'
                                      CHECK (state IN ('active', 'exhausted', 'expired', 'revoked')),
  revoked_by_user_id    UUID         REFERENCES oweibo.users(id),
  revoked_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT time_windowed_grants_user_required
    CHECK (granted_to_kind = 'agent' OR granted_to_user_id IS NOT NULL),
  CONSTRAINT time_windowed_grants_revoke_consistent
    CHECK ((revoked_by_user_id IS NULL) = (revoked_at IS NULL))
);

ALTER TABLE oweibo.time_windowed_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.time_windowed_grants FORCE ROW LEVEL SECURITY;

CREATE POLICY time_windowed_grants_tenant
  ON oweibo.time_windowed_grants
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY time_windowed_grants_platform_admin
  ON oweibo.time_windowed_grants
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE ON oweibo.time_windowed_grants TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_grants_active
  ON oweibo.time_windowed_grants (tenant_id, action_class, expires_at)
  WHERE state = 'active';

-- ── approval_delegations ─────────────────────────────────────────────────
-- "User A delegates approval authority for class X to user B until T."
-- Delegations are not transitive; the service refuses to honor a
-- delegate-of-delegate at lookup time. A delegation row itself is the
-- result of an approval action (audited via action_proposals when the
-- service creates it).
CREATE TABLE IF NOT EXISTS oweibo.approval_delegations (
  delegator_user_id  UUID         NOT NULL REFERENCES oweibo.users(id),
  delegate_user_id   UUID         NOT NULL REFERENCES oweibo.users(id),
  tenant_id          UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  action_class       TEXT         NOT NULL,
  expires_at         TIMESTAMPTZ  NOT NULL,
  revoked_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (delegator_user_id, delegate_user_id, tenant_id, action_class),
  CONSTRAINT approval_delegations_distinct CHECK (delegator_user_id <> delegate_user_id)
);

ALTER TABLE oweibo.approval_delegations ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.approval_delegations FORCE ROW LEVEL SECURITY;

CREATE POLICY approval_delegations_tenant
  ON oweibo.approval_delegations
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY approval_delegations_platform_admin
  ON oweibo.approval_delegations
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE ON oweibo.approval_delegations TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_delegations_active
  ON oweibo.approval_delegations (delegate_user_id, tenant_id, action_class, expires_at)
  WHERE revoked_at IS NULL;

-- ── action_proposals.grant_id ────────────────────────────────────────────
-- When a proposal is auto-promoted via a grant, the grant id is recorded
-- so audit can join proposal → grant → approvers. Nullable: most proposals
-- are not grant-driven.
ALTER TABLE oweibo.action_proposals
  ADD COLUMN IF NOT EXISTS grant_id UUID REFERENCES oweibo.time_windowed_grants(id);

CREATE INDEX IF NOT EXISTS idx_action_proposals_grant
  ON oweibo.action_proposals (grant_id)
  WHERE grant_id IS NOT NULL;

COMMIT;

DO $$
BEGIN
  RAISE NOTICE 'S.4 multi-party + time-windowed approvals installed.';
END;
$$;
