-- S.6 (ttv-action-safety-v2): action quotas & budget insurance.
--
-- Distinct from S.2 rate limits (short-window flow control). S.6 enforces
-- absolute caps over longer windows (day / month / year) and a per-tenant
-- budget-insurance pool for predictable enterprise billing.
--
-- Adds:
--   * quota_policies         — per-(tenant, kind, scope, window) caps
--   * quota_consumption      — running counters claimed atomically
--   * budget_insurance_pools — opt-in commit-and-protect pool
--   * platform_action_cost_priors — cross-tenant cost percentiles (K≥5)
--
-- Pre-flight: requires ttv.md T.−1 (action_proposals, tenants).
--
-- Feature gate: `action_quotas.enabled`. With the flag off, the engine's
-- QuotaService.preflight() returns ok unconditionally; no rows are
-- written here so the schema is byte-identical to today from the app's
-- POV when the flag is off.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'oweibo' AND table_name = 'action_proposals'
  ) THEN
    RAISE EXCEPTION 'S.6 migration requires ttv.md T.−1 (action_proposals) to be applied first.';
  END IF;
END $$;

BEGIN;

-- ── quota_policies ──────────────────────────────────────────────────────
-- One row per (tenant, kind, scope, window). `scope` is the action_class
-- for per-class quotas, or '*' for tenant-wide totals. The composite PK
-- includes scope (with COALESCE-friendly NULL handled by '*' sentinel)
-- so per-class and total rows coexist.
CREATE TABLE IF NOT EXISTS oweibo.quota_policies (
  tenant_id                  UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  quota_kind                 TEXT         NOT NULL
                              CHECK (quota_kind IN (
                                'action_count_per_class',
                                'usd_cost_per_class',
                                'usd_cost_total',
                                'total_actions',
                                'blast_radius_user_count'
                              )),
  scope                      TEXT         NOT NULL DEFAULT '*',
  -- Named window_kind, not window: WINDOW is a reserved word in Postgres and
  -- an unquoted `window` column is a syntax error (defect found 2026-07-10 —
  -- this migration could never have applied as originally written, so the
  -- rename is compat-safe: no database anywhere has the old shape).
  window_kind                TEXT         NOT NULL
                              CHECK (window_kind IN ('day', 'month', 'year')),
  limit_value                BIGINT       NOT NULL CHECK (limit_value > 0),
  cold_start_limit           BIGINT       CHECK (cold_start_limit IS NULL OR cold_start_limit > 0),
  cold_start_duration_days   INTEGER      NOT NULL DEFAULT 30 CHECK (cold_start_duration_days >= 0),
  enforcement_mode           TEXT         NOT NULL DEFAULT 'hard'
                              CHECK (enforcement_mode IN ('soft', 'hard')),
  updated_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, quota_kind, scope, window_kind)
);

ALTER TABLE oweibo.quota_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.quota_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY quota_policies_tenant
  ON oweibo.quota_policies
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY quota_policies_platform_admin
  ON oweibo.quota_policies
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.quota_policies TO oweibo_app;

-- ── quota_consumption ──────────────────────────────────────────────────
-- Running counter. window_start is the start of the window (truncated
-- to midnight UTC). Atomic increments happen via UPSERT in QuotaService.
CREATE TABLE IF NOT EXISTS oweibo.quota_consumption (
  tenant_id     UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  quota_kind    TEXT         NOT NULL,
  scope         TEXT         NOT NULL DEFAULT '*',
  window_kind   TEXT         NOT NULL CHECK (window_kind IN ('day', 'month', 'year')),
  window_start  DATE         NOT NULL,
  consumed      BIGINT       NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, quota_kind, scope, window_kind, window_start)
);

ALTER TABLE oweibo.quota_consumption ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.quota_consumption FORCE ROW LEVEL SECURITY;

CREATE POLICY quota_consumption_tenant
  ON oweibo.quota_consumption
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY quota_consumption_platform_admin
  ON oweibo.quota_consumption
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE ON oweibo.quota_consumption TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_quota_consumption_window
  ON oweibo.quota_consumption (tenant_id, quota_kind, scope, window_kind, window_start DESC);

-- ── budget_insurance_pools ─────────────────────────────────────────────
-- Opt-in commit-and-protect pool. One row per tenant. The pool covers
-- estimate-vs-actual overage on cost so enterprise tenants get
-- predictable billing in exchange for committed spend.
CREATE TABLE IF NOT EXISTS oweibo.budget_insurance_pools (
  tenant_id              UUID         PRIMARY KEY REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  commitment_usd_cents   BIGINT       NOT NULL CHECK (commitment_usd_cents >= 0),
  pool_balance_usd_cents BIGINT       NOT NULL CHECK (pool_balance_usd_cents >= 0),
  pool_period            TEXT         NOT NULL CHECK (pool_period IN ('month', 'quarter', 'year')),
  pool_resets_at         TIMESTAMPTZ  NOT NULL,
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE oweibo.budget_insurance_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.budget_insurance_pools FORCE ROW LEVEL SECURITY;

CREATE POLICY budget_insurance_pools_tenant
  ON oweibo.budget_insurance_pools
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY budget_insurance_pools_platform_admin
  ON oweibo.budget_insurance_pools
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE ON oweibo.budget_insurance_pools TO oweibo_app;

-- ── platform_action_cost_priors ─────────────────────────────────────────
-- Platform-wide cost percentiles for cold-start cost estimation.
-- Aggregated nightly by apps/platform-priors-aggregator with K ≥ 5
-- contributors (K-anonymity floor, matching ttv.md T.3.a).
CREATE TABLE IF NOT EXISTS oweibo.platform_action_cost_priors (
  action_class         TEXT         NOT NULL,
  capability_id        TEXT         NOT NULL,
  payload_size_bucket  TEXT         NOT NULL CHECK (payload_size_bucket IN ('xs', 'sm', 'md', 'lg', 'xl')),
  home_region          TEXT         NOT NULL DEFAULT '*',
  p50_cents            INTEGER      NOT NULL CHECK (p50_cents >= 0),
  p95_cents            INTEGER      NOT NULL CHECK (p95_cents >= 0),
  p99_cents            INTEGER      NOT NULL CHECK (p99_cents >= 0),
  sample_count         INTEGER      NOT NULL CHECK (sample_count >= 0),
  contributor_count    INTEGER      NOT NULL CHECK (contributor_count >= 5),
  computed_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (action_class, capability_id, payload_size_bucket, home_region)
);

-- Platform-wide table (no tenant_id). Same access pattern as
-- platform_bandit_priors: oweibo_app reads, platform_admin writes (the
-- aggregator runs as platform_admin).
GRANT SELECT ON oweibo.platform_action_cost_priors TO oweibo_app;

COMMIT;

DO $$
BEGIN
  RAISE NOTICE 'S.6 quotas + budget insurance + cost priors installed.';
END;
$$;
