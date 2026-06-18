-- F.1 (ttv-finals): Infrastructure tables for the runtime channels +
-- per-tenant webhook config.
--
-- Two new tables:
--   1. tenant_webhook_configs            — per-tenant webhook URL + HMAC
--                                          secret for rollback + notification
--                                          channels. Consumed by
--                                          PgWebhookConfigResolver (F.1.6) and
--                                          GenericWebhookRollbackAdapter (S.3).
--   2. tenant_notification_channel_config — per-tenant per-channel toggles
--                                          + arbitrary JSON config (e.g.
--                                          quiet-hours rules, slack channel
--                                          IDs). Consumed by EmailChannel /
--                                          SlackChannel / WebhookChannel (F.1.3).
--
-- Both are tenant-scoped, RLS-enforced, and follow the convention from
-- 20260521_000042_as_approval_sla.sql (enable + force RLS, tenant policy +
-- platform_admin bypass, GRANT to oweibo_app).
--
-- HMAC secrets are stored encrypted as raw bytes (BYTEA) with a key-id
-- pointer (TEXT). Decryption is owned by the runtime resolver via
-- SecretsManager — the DB never sees plaintext.

BEGIN;

-- ── tenant_webhook_configs ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oweibo.tenant_webhook_configs (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  kind             TEXT         NOT NULL CHECK (kind IN ('rollback','notification')),
  url              TEXT         NOT NULL,
  -- HMAC secret: kid points the runtime at a key in SecretsManager; ct is
  -- the AES-GCM ciphertext of the secret payload (or any wrapped form the
  -- resolver supports). NULL ct means no signed payloads (best-effort delivery).
  hmac_secret_kid  TEXT,
  hmac_secret_ct   BYTEA,
  enabled          BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE oweibo.tenant_webhook_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.tenant_webhook_configs FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_webhook_configs_tenant
  ON oweibo.tenant_webhook_configs
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY tenant_webhook_configs_platform_admin
  ON oweibo.tenant_webhook_configs
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.tenant_webhook_configs TO oweibo_app;

-- Resolver-lookup index: most-recently-updated enabled webhook per
-- (tenant_id, kind). Partial-on-enabled to keep the index hot.
CREATE INDEX IF NOT EXISTS idx_tenant_webhook_configs_lookup
  ON oweibo.tenant_webhook_configs (tenant_id, kind, updated_at DESC)
  WHERE enabled = TRUE;

-- updated_at touch trigger.
CREATE OR REPLACE FUNCTION oweibo.touch_tenant_webhook_configs_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenant_webhook_configs_touch ON oweibo.tenant_webhook_configs;
CREATE TRIGGER trg_tenant_webhook_configs_touch
  BEFORE UPDATE ON oweibo.tenant_webhook_configs
  FOR EACH ROW
  EXECUTE FUNCTION oweibo.touch_tenant_webhook_configs_updated_at();

-- ── tenant_notification_channel_config ──────────────────────────────────
-- Per-tenant per-channel-kind toggles + free-form JSONB config (quiet
-- hours rules, slack channel_id, email from-address, etc.). The channel
-- implementations validate their own config shape; the schema is open
-- by design (each channel evolves its config independently).
CREATE TABLE IF NOT EXISTS oweibo.tenant_notification_channel_config (
  tenant_id    UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  channel_kind TEXT         NOT NULL CHECK (channel_kind IN ('slack','email','webhook','in_app')),
  config       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  enabled      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, channel_kind)
);

ALTER TABLE oweibo.tenant_notification_channel_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.tenant_notification_channel_config FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_notification_channel_config_tenant
  ON oweibo.tenant_notification_channel_config
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY tenant_notification_channel_config_platform_admin
  ON oweibo.tenant_notification_channel_config
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE
  ON oweibo.tenant_notification_channel_config TO oweibo_app;

CREATE OR REPLACE FUNCTION oweibo.touch_tenant_notification_channel_config_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenant_notification_channel_config_touch
  ON oweibo.tenant_notification_channel_config;
CREATE TRIGGER trg_tenant_notification_channel_config_touch
  BEFORE UPDATE ON oweibo.tenant_notification_channel_config
  FOR EACH ROW
  EXECUTE FUNCTION oweibo.touch_tenant_notification_channel_config_updated_at();

DO $$
BEGIN
  RAISE NOTICE 'F.1 (ttv-finals) infrastructure tables created: tenant_webhook_configs, tenant_notification_channel_config.';
END;
$$;

COMMIT;
