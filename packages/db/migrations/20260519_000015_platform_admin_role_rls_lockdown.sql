-- Migration: Platform-admin role + usage_records RLS lockdown.
--
-- Two structural fixes flagged by the isolation audit:
--
--   1. RLS bypass was gated on a GUC (current_setting('app.is_platform_admin')) which
--      any oweibo_app transaction can SET LOCAL. Replace with a role-based check —
--      bypass requires SET LOCAL ROLE platform_admin (a role with BYPASSRLS).
--      Same proven pattern as gepa_optimizer in the prompt-privilege migration.
--
--   2. oweibo.usage_records had no RLS — tenant_id was an attribution key only.
--      Any code path that issued a raw SELECT on the table would see every
--      tenant's usage. Add tenant_isolation + platform_admin_bypass policies and
--      provide a SECURITY DEFINER aggregation function for cross-tenant rollups
--      (so finance reporting doesn't require BYPASSRLS).
--
-- Requires: 20260519_000014_prompt_privilege_lockdown.sql already applied.

-- ── 1. Create platform_admin role with BYPASSRLS ────────────────────────────
-- BYPASSRLS is a role attribute (not an inheritable privilege), so oweibo_app
-- being a member of platform_admin does NOT make oweibo_app bypass RLS.
-- Only after SET LOCAL ROLE platform_admin does current_user become
-- platform_admin and the attribute take effect.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'platform_admin') THEN
    CREATE ROLE platform_admin NOLOGIN BYPASSRLS;
    RAISE NOTICE 'Created platform_admin role.';
  END IF;
END;
$$;

-- ── 2. Grant platform_admin schema + table privileges ───────────────────────
GRANT USAGE ON SCHEMA oweibo TO platform_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA oweibo TO platform_admin;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA oweibo TO platform_admin;
GRANT EXECUTE                        ON ALL FUNCTIONS IN SCHEMA oweibo TO platform_admin;

ALTER DEFAULT PRIVILEGES IN SCHEMA oweibo
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO platform_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA oweibo
  GRANT USAGE, SELECT                  ON SEQUENCES TO platform_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA oweibo
  GRANT EXECUTE                        ON FUNCTIONS TO platform_admin;

-- ── 3. Grant role membership — SET ROLE only, NO privilege inheritance ──────
-- WITH INHERIT FALSE prevents oweibo_app from auto-inheriting platform_admin's
-- privileges. Together with NOLOGIN BYPASSRLS, the only way to reach
-- platform_admin's authority is an explicit SET LOCAL ROLE platform_admin,
-- which is grep-able and audit-friendly.
GRANT platform_admin TO oweibo_app WITH INHERIT FALSE, SET TRUE;

-- ── 4. Migrate platform_admin_bypass policies from GUC → role check ─────────
-- Every existing oweibo.* platform_admin_bypass policy switches from
--   current_setting('app.is_platform_admin', true) = 'true'
-- to
--   current_user = 'platform_admin'
-- The GUC is no longer load-bearing; SET LOCAL app.is_platform_admin has
-- no effect anywhere after this migration.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT schemaname, tablename
    FROM pg_policies
    WHERE policyname = 'platform_admin_bypass'
      AND schemaname = 'oweibo'
  LOOP
    EXECUTE format(
      'ALTER POLICY platform_admin_bypass ON %I.%I USING (current_user = %L)',
      r.schemaname, r.tablename, 'platform_admin'
    );
    RAISE NOTICE 'Migrated platform_admin_bypass on %.%', r.schemaname, r.tablename;
  END LOOP;
END;
$$;

-- ── 5. Enable RLS on oweibo.usage_records ───────────────────────────────────
-- Previously: no RLS, tenant_id was an attribution key only. Any privilege
-- escalation (or future SELECT grant to a finance role) would expose every
-- tenant's billing/usage data — a high-value cross-tenant leak target.
ALTER TABLE oweibo.usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.usage_records FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON oweibo.usage_records
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY platform_admin_bypass ON oweibo.usage_records
  FOR ALL
  USING (current_user = 'platform_admin');

-- oweibo_app keeps INSERT (with tenant_isolation WITH CHECK enforcing the
-- inserted tenant_id matches app.tenant_id). No SELECT grant — tenants do
-- not read raw usage rows; cross-tenant rollups go through the SECURITY
-- DEFINER aggregation function below.
-- (Existing GRANT INSERT was issued in migration 20260508_000004.)

-- ── 6. SECURITY DEFINER aggregation for cross-tenant rollups ────────────────
-- Called by platform_admin contexts to produce billing/usage rollups WITHOUT
-- needing BYPASSRLS at the caller site. Owner = migration superuser, so the
-- function bypasses RLS internally; EXECUTE is restricted to platform_admin
-- (oweibo_app, not being a privilege-inheriting member, cannot call it
-- without SET LOCAL ROLE platform_admin).
CREATE OR REPLACE FUNCTION oweibo.usage_records_aggregate(
  p_start        TIMESTAMPTZ,
  p_end          TIMESTAMPTZ,
  p_record_type  TEXT    DEFAULT NULL,
  p_billed_only  BOOLEAN DEFAULT FALSE
) RETURNS TABLE (
  tenant_id       UUID,
  record_type     TEXT,
  total_quantity  NUMERIC,
  total_cost_usd  NUMERIC,
  call_count      BIGINT
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = oweibo, pg_temp
AS $$
  SELECT
    u.tenant_id,
    u.record_type,
    SUM(u.quantity)::NUMERIC AS total_quantity,
    SUM(u.cost_usd)::NUMERIC AS total_cost_usd,
    COUNT(*)::BIGINT         AS call_count
  FROM oweibo.usage_records u
  WHERE u.recorded_at >= p_start
    AND u.recorded_at <  p_end
    AND (p_record_type IS NULL OR u.record_type = p_record_type)
    AND (NOT p_billed_only OR u.billed = TRUE)
  GROUP BY u.tenant_id, u.record_type;
$$;

REVOKE EXECUTE ON FUNCTION
  oweibo.usage_records_aggregate(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BOOLEAN)
  FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION
  oweibo.usage_records_aggregate(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BOOLEAN)
  TO platform_admin;

-- ── Notify ──────────────────────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE 'platform_admin role + usage_records RLS lockdown applied. App role can no longer bypass RLS via GUC; use SET LOCAL ROLE platform_admin.';
END;
$$;
