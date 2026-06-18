-- Migration: Tenant-binding lookup functions.
--
-- A signed JWT proves the IdP issued the claim at some point in time. It does
-- NOT prove the user still has a corresponding tenant membership now. The
-- existing flow trusted `principal.ctx.tenantId` directly as `app.tenant_id`,
-- so a stale token (issued before a membership was revoked) or a token whose
-- claim never matched the DB at all would silently scope queries to a tenant
-- the principal no longer (or never) had access to. RLS dutifully filtered
-- to that tenant — and the formerly-authorised user was back in.
--
-- These two SECURITY DEFINER STABLE functions let withTenantContext verify
-- the binding without first knowing the tenant_id (chicken-and-egg with RLS).
-- They bypass RLS internally and return only a boolean — no row data leaks
-- to a caller probing for memberships.
--
-- Requires: 20260519_000016_security_definer_hardening.sql.

-- ── 1. User → tenant membership check ───────────────────────────────────────
CREATE OR REPLACE FUNCTION oweibo.user_has_membership(
  p_user_id   UUID,
  p_tenant_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
PARALLEL SAFE
SET search_path = oweibo, pg_temp
AS $$
  SELECT EXISTS(
    SELECT 1 FROM oweibo.tenant_memberships
    WHERE user_id = p_user_id AND tenant_id = p_tenant_id
  );
$$;

REVOKE EXECUTE ON FUNCTION oweibo.user_has_membership(UUID, UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION oweibo.user_has_membership(UUID, UUID) TO oweibo_app;

-- ── 2. API-key validity + tenant binding check ──────────────────────────────
-- Returns true iff the key id exists, is bound to p_tenant_id, has not been
-- revoked, and has not expired. Mirrors the production validity contract.
CREATE OR REPLACE FUNCTION oweibo.api_key_valid(
  p_key_id    UUID,
  p_tenant_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
PARALLEL SAFE
SET search_path = oweibo, pg_temp
AS $$
  SELECT EXISTS(
    SELECT 1 FROM oweibo.api_keys
    WHERE id          = p_key_id
      AND tenant_id   = p_tenant_id
      AND revoked_at  IS NULL
      AND (expires_at IS NULL OR expires_at > NOW())
  );
$$;

REVOKE EXECUTE ON FUNCTION oweibo.api_key_valid(UUID, UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION oweibo.api_key_valid(UUID, UUID) TO oweibo_app;

DO $$
BEGIN
  RAISE NOTICE 'Tenant-binding lookup functions created. withTenantContext can now verify principal.ctx.tenantId against authoritative DB state.';
END;
$$;
