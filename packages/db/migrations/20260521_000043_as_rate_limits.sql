-- S.2 (ttv-action-safety-v2): per-tenant action rate limiting.
--
-- Two tables:
--   1. rate_limit_policies — per-tenant per-class budget config
--   2. rate_limit_events — append-only log of throttled / sustained-burst
--      events for observability + tuning
--
-- The hot path uses a Redis-backed token bucket — these tables are config
-- and audit only. Pre-flight: requires ttv.md T.−1 (action taxonomy).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'oweibo' AND table_name = 'action_proposals'
  ) THEN
    RAISE EXCEPTION 'S.2 migration requires ttv.md T.−1 (action_proposals) to be applied first.';
  END IF;
END $$;

BEGIN;

-- ── rate_limit_policies ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oweibo.rate_limit_policies (
  tenant_id                UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  action_class             TEXT         NOT NULL,
  per_minute               INTEGER      NOT NULL CHECK (per_minute >= 0),
  per_hour                 INTEGER      NOT NULL CHECK (per_hour >= 0),
  per_day                  INTEGER      NOT NULL CHECK (per_day >= 0),
  burst_allowance          INTEGER      NOT NULL DEFAULT 0,
  cold_start_multiplier    NUMERIC(4,3) NOT NULL DEFAULT 1.0
                                          CHECK (cold_start_multiplier BETWEEN 0.05 AND 1.0),
  cold_start_duration_days INTEGER      NOT NULL DEFAULT 0,
  enforcement_mode         TEXT         NOT NULL DEFAULT 'soft'
                                          CHECK (enforcement_mode IN ('soft', 'hard')),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, action_class)
);

ALTER TABLE oweibo.rate_limit_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.rate_limit_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY rate_limit_policies_tenant
  ON oweibo.rate_limit_policies
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY rate_limit_policies_platform_admin
  ON oweibo.rate_limit_policies
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.rate_limit_policies TO oweibo_app;

-- ── rate_limit_events ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oweibo.rate_limit_events (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  action_class    TEXT         NOT NULL,
  window_kind     TEXT         NOT NULL CHECK (window_kind IN ('minute', 'hour', 'day')),
  event_kind      TEXT         NOT NULL CHECK (event_kind IN
                                                ('throttled_soft', 'throttled_hard', 'sustained_burst')),
  occurred_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  context         JSONB
);

ALTER TABLE oweibo.rate_limit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.rate_limit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY rate_limit_events_tenant
  ON oweibo.rate_limit_events
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY rate_limit_events_platform_admin
  ON oweibo.rate_limit_events
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT ON oweibo.rate_limit_events TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_rate_limit_events_recent
  ON oweibo.rate_limit_events (tenant_id, action_class, occurred_at DESC);

COMMIT;

DO $$
BEGIN
  RAISE NOTICE 'S.2 rate_limit_policies + rate_limit_events installed.';
END;
$$;
