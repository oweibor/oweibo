-- Migration: Phase B — cross-tenant distillation schema
-- DONE: Phase B.7
-- Requires: 20260507_000000_phase_a_foundations.sql already applied.

-- ── oweibo.platform_lessons ─────────────────────────────────────────────────
-- Stores anonymised lessons after HMAC verify + DLP + identity strip.
-- tenantId is NEVER stored here — stripped by PatternAggregator before insert.

CREATE TABLE IF NOT EXISTS oweibo.platform_lessons (
  fingerprint           TEXT         PRIMARY KEY,   -- SHA256(taskId:role:slotId:errorClass)
  bucket_key            TEXT         NOT NULL,      -- role:slotId:errorClass — for k-anonymity grouping
  schema_version        TEXT         NOT NULL DEFAULT '1',
  role                  TEXT         NOT NULL CHECK (role IN ('architect','executor','reviewer','decomposer')),
  slot_id               TEXT         NOT NULL,
  channel               TEXT         NOT NULL,
  outcome               TEXT         NOT NULL CHECK (outcome IN ('success','failure','recovery')),
  abstract_pattern      TEXT         NOT NULL,
  tool_sequence         JSONB        NOT NULL DEFAULT '[]',
  error_class           TEXT,
  subgoal_count         INTEGER,
  dependency_edge_count INTEGER,
  estimated_complexity  NUMERIC(8,2),
  confidence            NUMERIC(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  generated_at          TIMESTAMPTZ  NOT NULL,
  aggregated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_lessons_bucket  ON oweibo.platform_lessons (bucket_key);
CREATE INDEX IF NOT EXISTS idx_platform_lessons_role    ON oweibo.platform_lessons (role, slot_id);
CREATE INDEX IF NOT EXISTS idx_platform_lessons_outcome ON oweibo.platform_lessons (outcome);

-- ── oweibo.platform_lesson_tenants ──────────────────────────────────────────
-- Tracks which tenants contributed to each bucket WITHOUT storing the lesson
-- content alongside the tenantId. Hashed tenantId preserves k-anonymity counting
-- while preventing re-identification from this table alone.

CREATE TABLE IF NOT EXISTS oweibo.platform_lesson_tenants (
  bucket_key       TEXT         NOT NULL,
  tenant_hash      TEXT         NOT NULL,   -- SHA256(tenantId) — one-way
  first_seen_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (bucket_key, tenant_hash)
);

-- ── oweibo.releasable_buckets (materialised view) ──────────────────────────
-- GEPA optimizer reads ONLY from this view — direct access to platform_lessons
-- requires the platform_admin role. The view is refreshed before each GEPA run.

CREATE MATERIALIZED VIEW IF NOT EXISTS oweibo.releasable_buckets AS
  SELECT
    pl.bucket_key,
    pl.role,
    pl.slot_id,
    COUNT(DISTINCT plt.tenant_hash) AS tenant_count,
    COUNT(pl.fingerprint)           AS lesson_count,
    AVG(pl.confidence)              AS avg_confidence,
    MAX(pl.aggregated_at)           AS latest_aggregated_at
  FROM oweibo.platform_lessons pl
  JOIN oweibo.platform_lesson_tenants plt USING (bucket_key)
  GROUP BY pl.bucket_key, pl.role, pl.slot_id
  HAVING COUNT(DISTINCT plt.tenant_hash) >= 5   -- k-anonymity threshold
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_releasable_buckets_pk
  ON oweibo.releasable_buckets (bucket_key);

-- ── oweibo.tenant_anomaly_flags ─────────────────────────────────────────────
-- Used by the participation eligibility filter (§B.6b).

CREATE TABLE IF NOT EXISTS oweibo.tenant_anomaly_flags (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES oweibo.tenants(id),
  flag_type   TEXT        NOT NULL,
  raised_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  notes       TEXT
);

ALTER TABLE oweibo.tenant_anomaly_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.tenant_anomaly_flags FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_anomaly_isolation ON oweibo.tenant_anomaly_flags
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY platform_admin_anomaly ON oweibo.tenant_anomaly_flags
  FOR ALL USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE ON oweibo.tenant_anomaly_flags TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_tenant_anomaly_active
  ON oweibo.tenant_anomaly_flags (tenant_id, raised_at)
  WHERE resolved_at IS NULL;

-- ── oweibo.tenant_confidentiality_budget ─────────────────────────────────────
-- Per-tenant confidentiality sensitivity budget (§B.3c).

CREATE TABLE IF NOT EXISTS oweibo.tenant_confidentiality_budget (
  tenant_id          UUID         PRIMARY KEY REFERENCES oweibo.tenants(id),
  threshold_override NUMERIC(4,3) DEFAULT NULL,  -- NULL → use global 0.65
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_by         TEXT
);

GRANT SELECT, INSERT, UPDATE ON oweibo.tenant_confidentiality_budget TO oweibo_app;

-- ── Grant GEPA service account read-only on releasable_buckets ───────────────
-- Direct access to platform_lessons is NOT granted to gepa_optimizer role.
-- (Role must exist; created separately by infra provisioning.)

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gepa_optimizer') THEN
    GRANT SELECT ON oweibo.releasable_buckets TO gepa_optimizer;
    REVOKE SELECT ON oweibo.platform_lessons   FROM gepa_optimizer;
    REVOKE SELECT ON oweibo.platform_lesson_tenants FROM gepa_optimizer;
  END IF;
END;
$$;

-- Notify
DO $$
BEGIN
  RAISE NOTICE 'Phase B distillation schema applied successfully.';
END;
$$;
