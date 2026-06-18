-- Migration: pg NOTIFY for tenant-binding cache invalidation.
--
-- The in-process tenant-binding cache in @oweibo/db (60 s TTL) closes the
-- "stale token after membership revocation" window — but only within that
-- TTL. To bring revocation propagation down to sub-second, we emit a
-- pg_notify whenever tenant_memberships or api_keys changes, and Node
-- listeners evict the matching cache entry on receipt.
--
-- Payload shape (JSON, well under the 8 KB NOTIFY limit):
--   { "kind": "user" | "api_key",
--     "subject":  "<uuid-of-user-or-key>",
--     "tenantId": "<uuid>",
--     "op":       "insert" | "update" | "delete" }
--
-- Notifications are transaction-scoped — they only fire on COMMIT, so a
-- rolled-back UPDATE will not spuriously invalidate any cache.
--
-- Requires: 20260519_000018_tenant_binding_lookup.sql.

CREATE OR REPLACE FUNCTION oweibo.notify_tenant_binding_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_kind      TEXT;
  v_subject   UUID;
  v_tenant_id UUID;
  v_payload   JSONB;
BEGIN
  IF TG_TABLE_NAME = 'tenant_memberships' THEN
    v_kind := 'user';
    IF TG_OP = 'DELETE' THEN
      v_subject   := OLD.user_id;
      v_tenant_id := OLD.tenant_id;
    ELSE
      v_subject   := NEW.user_id;
      v_tenant_id := NEW.tenant_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'api_keys' THEN
    v_kind := 'api_key';
    IF TG_OP = 'DELETE' THEN
      v_subject   := OLD.id;
      v_tenant_id := OLD.tenant_id;
    ELSE
      v_subject   := NEW.id;
      v_tenant_id := NEW.tenant_id;
    END IF;
  ELSE
    RETURN NULL;
  END IF;

  v_payload := jsonb_build_object(
    'kind',     v_kind,
    'subject',  v_subject::text,
    'tenantId', v_tenant_id::text,
    'op',       lower(TG_OP)
  );
  PERFORM pg_notify('oweibo_tenant_binding_changed', v_payload::text);
  RETURN NULL;  -- AFTER trigger, return value ignored
END;
$$;

-- Attach triggers (idempotent — drop first to allow re-runs).
DROP TRIGGER IF EXISTS notify_membership_change ON oweibo.tenant_memberships;
CREATE TRIGGER notify_membership_change
AFTER INSERT OR UPDATE OR DELETE ON oweibo.tenant_memberships
FOR EACH ROW EXECUTE FUNCTION oweibo.notify_tenant_binding_change();

DROP TRIGGER IF EXISTS notify_api_key_change ON oweibo.api_keys;
CREATE TRIGGER notify_api_key_change
AFTER UPDATE OR DELETE ON oweibo.api_keys
FOR EACH ROW EXECUTE FUNCTION oweibo.notify_tenant_binding_change();
-- INSERT on api_keys cannot invalidate any existing cache entry (the key is
-- new); so no trigger for INSERT — saves a NOTIFY on every key creation.

DO $$
BEGIN
  RAISE NOTICE 'Tenant-binding NOTIFY trigger installed on tenant_memberships + api_keys.';
END;
$$;
