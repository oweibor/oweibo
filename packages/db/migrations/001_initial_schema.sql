-- Migration 001: initial oweibo schema with RLS
-- Run once against Postgres 16+.
-- betterauth.* tables are created by the BetterAuth library at startup.

-- ── Schema setup ───────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS betterauth;
CREATE SCHEMA IF NOT EXISTS oweibo;

-- ── Roles ──────────────────────────────────────────────────────────────────
-- betterauth_app: owns betterauth.* tables, blocked from oweibo.*
-- oweibo_app: owns oweibo.* tables; uses RLS for tenant isolation

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'betterauth_app') THEN
    CREATE ROLE betterauth_app LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'oweibo_app') THEN
    CREATE ROLE oweibo_app LOGIN;
  END IF;
END $$;

-- Grant schema-level usage
GRANT USAGE ON SCHEMA betterauth TO betterauth_app;
GRANT USAGE ON SCHEMA oweibo TO oweibo_app;
-- oweibo_app reads betterauth.users.id for FK joins (trigger-maintained mirror)
GRANT USAGE ON SCHEMA betterauth TO oweibo_app;

-- ── oweibo.tenants ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.tenants (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT        NOT NULL,
  slug              TEXT        UNIQUE NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'suspended', 'deleted')),
  trust_mode_default TEXT       NOT NULL DEFAULT 'supervised'
                                CHECK (trust_mode_default IN ('supervised', 'graduated', 'autonomous')),
  features          JSONB       NOT NULL DEFAULT '{}',
  quotas            JSONB       NOT NULL DEFAULT '{
    "maxConcurrentTasks": 3,
    "maxScrapesPerDay": 10,
    "storageBytes": 1073741824,
    "rpsCap": 10,
    "maxTokensPerDay": 1000000,
    "maxAgentRunMinutesPerDay": 60
  }',
  home_region       TEXT        NOT NULL DEFAULT 'us-east-1',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- FK to oweibo.users(id) is added below, AFTER oweibo.users exists.
  -- An inline REFERENCES here fails on a fresh database because
  -- oweibo.users is created later in this same migration.
  created_by        UUID
);

-- No tenant_id column; platform_admin_bypass is the only non-owner policy
ALTER TABLE oweibo.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.tenants FORCE ROW LEVEL SECURITY;

CREATE POLICY platform_admin_bypass ON oweibo.tenants
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.tenants TO oweibo_app;

-- ── oweibo.users (mirror of betterauth.users) ──────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.users (
  id             UUID        PRIMARY KEY,  -- mirrors betterauth.users.id
  email          TEXT        UNIQUE NOT NULL,
  status         TEXT        NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'suspended', 'deleted')),
  platform_roles TEXT[]      NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cross-tenant table; no tenant_id RLS — platform_admin sees all
ALTER TABLE oweibo.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.users FORCE ROW LEVEL SECURITY;

CREATE POLICY platform_admin_bypass ON oweibo.users
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

-- Users can read their own row (required for JWT subject resolution)
CREATE POLICY self_read ON oweibo.users
  FOR SELECT
  USING (id::text = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE ON oweibo.users TO oweibo_app;

-- ── Deferred FK: oweibo.tenants.created_by → oweibo.users(id) ───────────────
-- Declared here rather than inline in oweibo.tenants above, because that
-- table is created before oweibo.users. Idempotent so re-running 001 is safe.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenants_created_by_fkey'
  ) THEN
    ALTER TABLE oweibo.tenants
      ADD CONSTRAINT tenants_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES oweibo.users(id);
  END IF;
END $$;

-- ── BetterAuth ↔ oweibo.users sync trigger ─────────────────────────────────

CREATE OR REPLACE FUNCTION oweibo.sync_user_from_betterauth()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO oweibo.users (id, email, status)
    VALUES (NEW.id::uuid, NEW.email, 'active')
    ON CONFLICT (id) DO NOTHING;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE oweibo.users SET email = NEW.email WHERE id = NEW.id::uuid;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE oweibo.users SET status = 'deleted' WHERE id = OLD.id::uuid;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS betterauth_user_sync ON betterauth.users;
CREATE TRIGGER betterauth_user_sync
AFTER INSERT OR UPDATE OR DELETE ON betterauth.users
FOR EACH ROW EXECUTE FUNCTION oweibo.sync_user_from_betterauth();

-- ── oweibo.tenant_memberships ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.tenant_memberships (
  user_id    UUID        NOT NULL REFERENCES oweibo.users(id),
  tenant_id  UUID        NOT NULL REFERENCES oweibo.tenants(id),
  roles      TEXT[]      NOT NULL,
  invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invited_by UUID        REFERENCES oweibo.users(id),
  PRIMARY KEY (user_id, tenant_id)
);

ALTER TABLE oweibo.tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.tenant_memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON oweibo.tenant_memberships
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY platform_admin_bypass ON oweibo.tenant_memberships
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.tenant_memberships TO oweibo_app;

-- ── oweibo.api_keys ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.api_keys (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL REFERENCES oweibo.tenants(id),
  created_by_user_id  UUID        NOT NULL REFERENCES oweibo.users(id),
  name                TEXT        NOT NULL,
  prefix              TEXT        NOT NULL,
  hashed_secret       TEXT        NOT NULL,
  scopes              TEXT[]      NOT NULL,
  expires_at          TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  last_used_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE oweibo.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.api_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON oweibo.api_keys
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY platform_admin_bypass ON oweibo.api_keys
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.api_keys TO oweibo_app;

-- ── oweibo.audit_log ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.audit_log (
  id                   UUID        NOT NULL,
  ts                   TIMESTAMPTZ NOT NULL,
  actor_principal      TEXT        NOT NULL,
  on_behalf_of_user_id UUID,
  source               TEXT        NOT NULL CHECK (source IN ('cli', 'web', 'api', 'system')),
  request_id           TEXT,
  ip                   INET,
  tenant_id            UUID,
  scope_used           TEXT[]      NOT NULL DEFAULT '{}',
  action               TEXT        NOT NULL,
  resource_type        TEXT,
  resource_id          TEXT,
  before_hash          TEXT,
  after_hash           TEXT,
  outcome              TEXT        NOT NULL CHECK (outcome IN ('allow', 'deny', 'error')),
  details              JSONB,
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

-- Current month partition (subsequent months added by cron)
CREATE TABLE IF NOT EXISTS oweibo.audit_log_2026_04 PARTITION OF oweibo.audit_log
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

CREATE TABLE IF NOT EXISTS oweibo.audit_log_2026_05 PARTITION OF oweibo.audit_log
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

ALTER TABLE oweibo.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.audit_log FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON oweibo.audit_log
  FOR SELECT
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY platform_admin_bypass ON oweibo.audit_log
  FOR SELECT
  USING (current_setting('app.is_platform_admin', true) = 'true');

-- No INSERT/UPDATE/DELETE policy → defaults deny for non-superuser
-- All inserts go through the SECURITY DEFINER function below

-- SECURITY DEFINER function: the only legal path to insert audit rows
CREATE OR REPLACE FUNCTION oweibo.append_audit(
  p_id                   UUID,
  p_ts                   TIMESTAMPTZ,
  p_actor_principal      TEXT,
  p_on_behalf_of_user_id UUID,
  p_source               TEXT,
  p_request_id           TEXT,
  p_ip                   TEXT,
  p_tenant_id            UUID,
  p_scope_used           TEXT[],
  p_action               TEXT,
  p_resource_type        TEXT,
  p_resource_id          TEXT,
  p_before_hash          TEXT,
  p_after_hash           TEXT,
  p_outcome              TEXT,
  p_details              JSONB
) RETURNS VOID AS $$
BEGIN
  INSERT INTO oweibo.audit_log (
    id, ts, actor_principal, on_behalf_of_user_id, source, request_id, ip,
    tenant_id, scope_used, action, resource_type, resource_id,
    before_hash, after_hash, outcome, details
  ) VALUES (
    p_id, p_ts, p_actor_principal, p_on_behalf_of_user_id, p_source, p_request_id,
    p_ip::inet, p_tenant_id, p_scope_used, p_action, p_resource_type, p_resource_id,
    p_before_hash, p_after_hash, p_outcome, p_details
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION oweibo.append_audit TO oweibo_app;

-- ── oweibo.outbox ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.outbox (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  subject      TEXT        NOT NULL,
  payload      JSONB       NOT NULL,
  published_at TIMESTAMPTZ
);

GRANT SELECT, INSERT, UPDATE ON oweibo.outbox TO oweibo_app;

-- ── Indexes ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_tenant_memberships_user   ON oweibo.tenant_memberships (user_id);
CREATE INDEX IF NOT EXISTS idx_tenant_memberships_tenant ON oweibo.tenant_memberships (tenant_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant           ON oweibo.api_keys (tenant_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix           ON oweibo.api_keys (prefix);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_ts       ON oweibo.audit_log (tenant_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_outbox_unpublished        ON oweibo.outbox (ts) WHERE published_at IS NULL;
