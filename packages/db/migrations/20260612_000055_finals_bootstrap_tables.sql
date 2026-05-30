-- F.5.0 (ttv-finals): Bootstrap step adapter preflight.
--
-- F.5 ships ten production adapters that target tables this migration creates
-- or extends. The earlier draft claimed "every table already shipped" — the
-- 57-file audit in plans/ttv-finals.md §F.5.0 surfaced four absent surfaces.
-- All additions are additive + idempotent (IF NOT EXISTS / conditional DO).
--
-- Targets:
--   1. oweibo.tenant_goal_templates_ack  — NEW. Per-tenant catalog ack log;
--                                          the existing goal_templates table
--                                          is the cross-tenant catalog.
--   2. oweibo.tenant_bandit_arms         — NEW. Tenant-scoped variant of
--                                          bandit_arms (which is platform).
--   3. oweibo.tenant_projects            — NEW. Starter project rows
--                                          written by SeedProjectStep.
--   4. ALTER tenant_connectors           — Allow status='recommended' so
--                                          SeedConnectorsStep can persist
--                                          its recommendation list.
--   5. ALTER action_proposals            — Add created_by_scopes TEXT[] for
--                                          F.2.5's scope propagation through
--                                          promote.
--
-- Preflight: scripts/check-bootstrap-tables.ts queries information_schema
-- after the migration runs and exits non-zero if any of the above are absent.

BEGIN;

-- ── 1. oweibo.tenant_goal_templates_ack ──────────────────────────────────
-- Per-tenant ack row written by SeedGoalTemplatesStep. The actual catalog
-- (oweibo.goal_templates) is cross-tenant and read-only to tenants.

CREATE TABLE IF NOT EXISTS oweibo.tenant_goal_templates_ack (
  tenant_id        UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  slug             TEXT         NOT NULL,
  catalog_version  TEXT         NOT NULL,
  source           TEXT         NOT NULL DEFAULT 'bootstrap',
  acknowledged_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, slug)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_goal_templates_ack_source_check'
  ) THEN
    ALTER TABLE oweibo.tenant_goal_templates_ack
      ADD CONSTRAINT tenant_goal_templates_ack_source_check
      CHECK (source IN ('bootstrap','manual','reconcile'))
      NOT VALID;
    ALTER TABLE oweibo.tenant_goal_templates_ack
      VALIDATE CONSTRAINT tenant_goal_templates_ack_source_check;
  END IF;
END $$;

ALTER TABLE oweibo.tenant_goal_templates_ack ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.tenant_goal_templates_ack FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.tenant_goal_templates_ack;
CREATE POLICY tenant_isolation ON oweibo.tenant_goal_templates_ack
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.tenant_goal_templates_ack TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_tenant_goal_templates_ack_tenant
  ON oweibo.tenant_goal_templates_ack (tenant_id, acknowledged_at DESC);

-- ── 2. oweibo.tenant_bandit_arms ─────────────────────────────────────────
-- Tenant-scoped bandit arms. Distinct from oweibo.bandit_arms (cross-tenant,
-- arm catalog). SeedPriorsStep writes one row per (slot, channel) it
-- pre-seeds for a new tenant.

CREATE TABLE IF NOT EXISTS oweibo.tenant_bandit_arms (
  tenant_id     UUID          NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  arm_id        TEXT          NOT NULL,
  slot_id       TEXT          NOT NULL,
  channel       TEXT          NOT NULL,
  alpha         NUMERIC(12,4) NOT NULL DEFAULT 1.0,
  beta          NUMERIC(12,4) NOT NULL DEFAULT 1.0,
  source        TEXT          NOT NULL DEFAULT 'cold_start',
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, arm_id, slot_id, channel)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_bandit_arms_alpha_pos'
  ) THEN
    ALTER TABLE oweibo.tenant_bandit_arms
      ADD CONSTRAINT tenant_bandit_arms_alpha_pos
      CHECK (alpha > 0 AND beta > 0)
      NOT VALID;
    ALTER TABLE oweibo.tenant_bandit_arms
      VALIDATE CONSTRAINT tenant_bandit_arms_alpha_pos;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_bandit_arms_source_check'
  ) THEN
    ALTER TABLE oweibo.tenant_bandit_arms
      ADD CONSTRAINT tenant_bandit_arms_source_check
      CHECK (source IN ('cold_start','platform_prior','observed','admin_override'))
      NOT VALID;
    ALTER TABLE oweibo.tenant_bandit_arms
      VALIDATE CONSTRAINT tenant_bandit_arms_source_check;
  END IF;
END $$;

ALTER TABLE oweibo.tenant_bandit_arms ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.tenant_bandit_arms FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.tenant_bandit_arms;
CREATE POLICY tenant_isolation ON oweibo.tenant_bandit_arms
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.tenant_bandit_arms TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_tenant_bandit_arms_slot
  ON oweibo.tenant_bandit_arms (tenant_id, slot_id, channel);

-- ── 3. oweibo.tenant_projects ────────────────────────────────────────────
-- Starter project rows. SeedProjectStep writes one row per template invariant
-- (typically one row total at bootstrap time).

CREATE TABLE IF NOT EXISTS oweibo.tenant_projects (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  template_slug  TEXT         NOT NULL,
  name           TEXT         NOT NULL,
  spec           JSONB        NOT NULL DEFAULT '{}',
  state          TEXT         NOT NULL DEFAULT 'active',
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_projects_state_check'
  ) THEN
    ALTER TABLE oweibo.tenant_projects
      ADD CONSTRAINT tenant_projects_state_check
      CHECK (state IN ('active','archived','deleted'))
      NOT VALID;
    ALTER TABLE oweibo.tenant_projects
      VALIDATE CONSTRAINT tenant_projects_state_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_projects_unique_starter'
  ) THEN
    ALTER TABLE oweibo.tenant_projects
      ADD CONSTRAINT tenant_projects_unique_starter
      UNIQUE (tenant_id, template_slug, name);
  END IF;
END $$;

ALTER TABLE oweibo.tenant_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.tenant_projects FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.tenant_projects;
CREATE POLICY tenant_isolation ON oweibo.tenant_projects
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.tenant_projects TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_tenant_projects_tenant_state
  ON oweibo.tenant_projects (tenant_id, state);

-- ── 4. ALTER tenant_connectors: allow status='recommended' ───────────────
-- T.2.f's CHECK constraint allowed pending|active|suspended|revoked. F.5.1's
-- PgConnectorRecommender writes rows in status='recommended' (operator must
-- still provide credentials before promotion to active).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_connectors_status_check'
  ) THEN
    ALTER TABLE oweibo.tenant_connectors
      DROP CONSTRAINT tenant_connectors_status_check;
  END IF;

  ALTER TABLE oweibo.tenant_connectors
    ADD CONSTRAINT tenant_connectors_status_check
    CHECK (status IN ('recommended','pending','active','suspended','revoked'))
    NOT VALID;
  ALTER TABLE oweibo.tenant_connectors
    VALIDATE CONSTRAINT tenant_connectors_status_check;
END $$;

-- ── 5. ALTER action_proposals: created_by_scopes for F.2.5 ───────────────
-- ActionContext.principalScopes propagates through the gate; on require-
-- approval mode the proposer's scopes are persisted so the approve/promote
-- flow can re-derive the principal's authority deterministically (without
-- re-fetching the JWT).

ALTER TABLE oweibo.action_proposals
  ADD COLUMN IF NOT EXISTS created_by_scopes TEXT[] NOT NULL DEFAULT '{}';

COMMIT;

DO $$
BEGIN
  RAISE NOTICE 'F.5.0 bootstrap tables installed (tenant_goal_templates_ack, tenant_bandit_arms, tenant_projects + ALTERs).';
END;
$$;
