-- Migration: SECURITY DEFINER hardening + tenant-provenance lookup.
--
-- Two related changes:
--
-- 1. Pin search_path on existing SECURITY DEFINER functions.
--    The original definitions of oweibo.append_audit and
--    oweibo.sync_user_from_betterauth in 001_initial_schema.sql lacked
--    SET search_path. An unprivileged caller can shadow built-in functions
--    (e.g. nextval, NOW) with their own schema entries placed earlier on
--    the search_path, then trigger the definer function and execute code
--    in the function owner's context. Pinning search_path to
--    `oweibo, pg_temp` closes that vector.
--
-- 2. Add oweibo.task_tenant(p_task_id) — a SECURITY DEFINER STABLE lookup
--    that returns the tenant_id stored on a task row without requiring
--    the caller to already know it. CostAttributor uses this to anchor
--    the tenant attribution of a usage_records insert to the task's
--    authenticated creation-time tenant, rather than trusting the
--    message-bus payload it just received. If the message-bus tenant_id
--    doesn't match the task's true tenant, the insert is aborted.
--
-- Requires: 20260519_000015_platform_admin_role_rls_lockdown.sql.

-- ── 1. Re-pin search_path on oweibo.append_audit ───────────────────────────
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
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = oweibo, pg_temp
AS $$
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
$$;

-- ── 2. Re-pin search_path on oweibo.sync_user_from_betterauth ──────────────
-- Trigger function fired on betterauth.users (cross-schema). search_path
-- must include both schemas explicitly.
CREATE OR REPLACE FUNCTION oweibo.sync_user_from_betterauth()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = oweibo, betterauth, pg_temp
AS $$
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
$$;

-- ── 3. Tenant-provenance lookup ─────────────────────────────────────────────
-- Returns the tenant_id stored on a task. oweibo.tasks is RLS-protected, so
-- a plain `SELECT tenant_id FROM oweibo.tasks WHERE id = ...` would return
-- 0 rows for any tenant context that isn't the task's own. This SECURITY
-- DEFINER variant bypasses RLS to return the authoritative value, which the
-- application then compares against the tenant_id it received from the
-- message bus. Returns NULL if the task doesn't exist.
--
-- The function is STABLE (no writes) and PARALLEL SAFE so it can be inlined
-- in WHERE clauses without serialisation cost.
CREATE OR REPLACE FUNCTION oweibo.task_tenant(p_task_id UUID)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
PARALLEL SAFE
SET search_path = oweibo, pg_temp
AS $$
  SELECT tenant_id FROM oweibo.tasks WHERE id = p_task_id;
$$;

REVOKE EXECUTE ON FUNCTION oweibo.task_tenant(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION oweibo.task_tenant(UUID) TO oweibo_app;

DO $$
BEGIN
  RAISE NOTICE 'SECURITY DEFINER hardening applied: search_path pinned on append_audit + sync_user_from_betterauth; task_tenant lookup created.';
END;
$$;
