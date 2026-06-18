-- T.−1: Action trust ladder, dry-run, and shadow-execution.
--
-- Establishes a per-(tenant, action_class) trust state with proposals, shadows,
-- and approvals for dry-run / shadow / require-approval modes. The lattice
-- activates only for newly-created tenants whose age qualifies them for the
-- cold-start defaults; established tenants (age >= 30d) resolve to 'execute'
-- by default — zero rows in tenant_action_class_state means resolver applies
-- the platform-default matrix in TypeScript (see ActionTrustLadder.ts).
--
-- This migration is purely additive — no existing rows touched, no columns
-- dropped, no constraints retroactively narrowed. With the runtime feature
-- flag action_trust_ladder.enabled = false, gate() returns {mode:'execute'}
-- deterministically and behavior is byte-identical to today.

-- ── Per-(tenant, action_class) trust state ────────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.tenant_action_class_state (
  tenant_id      UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  action_class   TEXT         NOT NULL,
  current_mode   TEXT         NOT NULL,
  pinned_by      TEXT,
  pinned_reason  TEXT,
  observations   INTEGER      NOT NULL DEFAULT 0,
  successes      INTEGER      NOT NULL DEFAULT 0,
  rejections     INTEGER      NOT NULL DEFAULT 0,
  last_updated   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, action_class)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenant_action_class_state_mode_check'
  ) THEN
    ALTER TABLE oweibo.tenant_action_class_state
      ADD CONSTRAINT tenant_action_class_state_mode_check
      CHECK (current_mode IN ('execute','dry_run','shadow','require_approval','forbidden'))
      NOT VALID;
    ALTER TABLE oweibo.tenant_action_class_state
      VALIDATE CONSTRAINT tenant_action_class_state_mode_check;
  END IF;
END $$;

ALTER TABLE oweibo.tenant_action_class_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.tenant_action_class_state FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.tenant_action_class_state;
CREATE POLICY tenant_isolation ON oweibo.tenant_action_class_state
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE ON oweibo.tenant_action_class_state TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_tenant_action_class_state_last_updated
  ON oweibo.tenant_action_class_state (tenant_id, last_updated DESC);

-- ── Append-only action proposals ──────────────────────────────────────────
-- Every dry-run / shadow / require_approval gate decision writes a row.
-- Idempotency: (tenant_id, action_id) unique — issuer-supplied action_id
-- prevents the same action being doubled if the issuer retries gate().

CREATE TABLE IF NOT EXISTS oweibo.action_proposals (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  user_id         UUID         REFERENCES oweibo.users(id),
  action_class    TEXT         NOT NULL,
  action_id       TEXT         NOT NULL,
  mode            TEXT         NOT NULL,
  summary         TEXT         NOT NULL,
  payload         JSONB        NOT NULL,
  rollback_kind   TEXT,
  rollback_detail JSONB,
  state           TEXT         NOT NULL DEFAULT 'pending',
  decided_by      UUID,
  decided_at      TIMESTAMPTZ,
  decision_reason TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ  NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'action_proposals_mode_check'
  ) THEN
    ALTER TABLE oweibo.action_proposals
      ADD CONSTRAINT action_proposals_mode_check
      CHECK (mode IN ('dry_run','shadow','require_approval'))
      NOT VALID;
    ALTER TABLE oweibo.action_proposals
      VALIDATE CONSTRAINT action_proposals_mode_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'action_proposals_state_check'
  ) THEN
    ALTER TABLE oweibo.action_proposals
      ADD CONSTRAINT action_proposals_state_check
      CHECK (state IN ('pending','promoted','rejected','expired','executed_shadow','executed_live'))
      NOT VALID;
    ALTER TABLE oweibo.action_proposals
      VALIDATE CONSTRAINT action_proposals_state_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'action_proposals_rollback_kind_check'
  ) THEN
    ALTER TABLE oweibo.action_proposals
      ADD CONSTRAINT action_proposals_rollback_kind_check
      CHECK (rollback_kind IS NULL OR rollback_kind IN ('trivial','reversible_with_cost','irreversible'))
      NOT VALID;
    ALTER TABLE oweibo.action_proposals
      VALIDATE CONSTRAINT action_proposals_rollback_kind_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'action_proposals_tenant_action_id_uniq'
  ) THEN
    ALTER TABLE oweibo.action_proposals
      ADD CONSTRAINT action_proposals_tenant_action_id_uniq
      UNIQUE (tenant_id, action_id);
  END IF;
END $$;

ALTER TABLE oweibo.action_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.action_proposals FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.action_proposals;
CREATE POLICY tenant_isolation ON oweibo.action_proposals
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE ON oweibo.action_proposals TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_action_proposals_pending
  ON oweibo.action_proposals (tenant_id, created_at DESC)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS idx_action_proposals_history
  ON oweibo.action_proposals (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_action_proposals_class
  ON oweibo.action_proposals (tenant_id, action_class, created_at DESC);

-- ── Backfill semantics ────────────────────────────────────────────────────
-- Zero rows in tenant_action_class_state means resolver applies the platform-
-- default matrix in TypeScript. For pre-existing tenants (age >= 30d), the
-- matrix returns 'execute' for every class — preserving backwards compat.
-- The lattice activates only for newly-created tenants whose age qualifies
-- them for the cold-start defaults. No data backfill required.

DO $$
BEGIN
  RAISE NOTICE 'T.−1 action trust ladder schema installed (tenant_action_class_state, action_proposals).';
END;
$$;
