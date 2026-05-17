-- Phase D.1 — Per-tenant cohort_channel + audit log.
--
-- Adds the cohort_channel column to tenant_settings that the plan's §13 spec
-- listed but was missing from the original 20260507_000000 foundations migration.
-- SwarmCoordinator now reads this column when starting a task (was hardcoded
-- to 'stable-v0'). Admin UI at /(platform)/cohorts surfaces and edits this.

-- ── Column ──────────────────────────────────────────────────────────────────

ALTER TABLE oweibo.tenant_settings
  ADD COLUMN IF NOT EXISTS cohort_channel TEXT NOT NULL DEFAULT 'stable-v0';

-- CHECK constraint is added as NOT VALID then validated — lets the alter
-- succeed even if rows already exist; the default above ensures all rows
-- satisfy the constraint by the time we validate.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenant_settings_cohort_channel_check'
  ) THEN
    ALTER TABLE oweibo.tenant_settings
      ADD CONSTRAINT tenant_settings_cohort_channel_check
      CHECK (cohort_channel IN ('stable-v0', 'stable', 'beta', 'fast', 'pending_human_review'))
      NOT VALID;
    ALTER TABLE oweibo.tenant_settings
      VALIDATE CONSTRAINT tenant_settings_cohort_channel_check;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tenant_settings_cohort_channel
  ON oweibo.tenant_settings (cohort_channel);

-- ── Audit log ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.tenant_cohort_changes (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES oweibo.tenants(id),
  previous_channel TEXT        NOT NULL,
  new_channel     TEXT         NOT NULL,
  reason          TEXT         NOT NULL,
  changed_by      TEXT         NOT NULL,
  changed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_cohort_changes_tenant
  ON oweibo.tenant_cohort_changes (tenant_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_tenant_cohort_changes_recent
  ON oweibo.tenant_cohort_changes (changed_at DESC);

GRANT SELECT, INSERT ON oweibo.tenant_cohort_changes TO oweibo_app;
