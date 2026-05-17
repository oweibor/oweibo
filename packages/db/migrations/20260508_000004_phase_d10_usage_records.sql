-- Migration: Phase D.10 — Per-tenant cost-attribution infrastructure.
-- Distillation-call cost is metered into oweibo.usage_records keyed by tenant.
-- v1 absorbs cost (billed=false); v2 flips to billed via config-only change.
-- Requires: 20260508_000002_phase_d_bandit.sql already applied.

-- ── oweibo.usage_records ─────────────────────────────────────────────────────
-- Each row is one metered event attributed to a tenant.
-- record_type: 'distillation' | 'eval' | 'model_inference' | 'gepa_mutation'
-- unit:        'call' | 'token' | 'usd'
-- billed:      false in v1 (absorb); flipped true in v2 via BILLING_ENABLED config

CREATE TABLE IF NOT EXISTS oweibo.usage_records (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID         NOT NULL,   -- not FK — avoids RLS complexity on platform tables
  record_type  TEXT         NOT NULL    CHECK (record_type IN (
                              'distillation', 'eval', 'model_inference',
                              'gepa_mutation', 'pattern_aggregation')),
  quantity     NUMERIC(14,4) NOT NULL DEFAULT 1,
  unit         TEXT         NOT NULL DEFAULT 'call'
                            CHECK (unit IN ('call', 'token', 'usd')),
  cost_usd     NUMERIC(12,6) NOT NULL DEFAULT 0,
  billed       BOOLEAN      NOT NULL DEFAULT false,
  metadata     JSONB,
  recorded_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- No RLS — usage_records is a platform table (not tenant-scoped reader);
-- tenant_id is an attribution key only, not an isolation boundary.
-- Tenants cannot read their own usage records via the app; finance/admin only.

CREATE INDEX IF NOT EXISTS idx_usage_records_tenant
  ON oweibo.usage_records (tenant_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_records_type
  ON oweibo.usage_records (record_type, recorded_at DESC);

GRANT INSERT ON oweibo.usage_records TO oweibo_app;
-- SELECT restricted to finance_admin_role (not created here; defined in IAM config)

-- ── oweibo.billing_config ─────────────────────────────────────────────────────
-- Single-row billing configuration — config-only billing switch for v1 → v2.

CREATE TABLE IF NOT EXISTS oweibo.billing_config (
  key        TEXT  PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO oweibo.billing_config (key, value) VALUES
  ('distillation_billing_enabled', 'false'),
  ('distillation_cost_usd_per_call', '0.0002'),
  ('eval_billing_enabled', 'false'),
  ('eval_cost_usd_per_call', '0.004')
ON CONFLICT (key) DO NOTHING;

GRANT SELECT ON oweibo.billing_config TO oweibo_app;
GRANT INSERT, UPDATE ON oweibo.billing_config TO oweibo_app;

DO $$
BEGIN
  RAISE NOTICE 'Phase D.10 usage_records schema applied successfully.';
END;
$$;
