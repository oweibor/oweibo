-- T.5.e: Seed A/B testing — per-tenant cohort label.
--
-- Adds a seed_cohort column to oweibo.tenant_bootstrap so each newly
-- provisioned tenant lands in either the 'seeded' arm (full T.2.a seed
-- install) or the 'control' arm (no seed memories installed). The
-- assignment is deterministic SHA256(tenant_id) mod 2 done at create-time
-- by SeedCohortAssigner in core-engine.
--
-- Backwards compatibility: existing tenant_bootstrap rows (from T.0
-- onwards) default to 'seeded' which preserves the intended behaviour for
-- tenants created before T.5.e. An 'exempt' cohort is reserved for
-- internal / synthetic tenants we never want included in cohort statistics.

ALTER TABLE oweibo.tenant_bootstrap
  ADD COLUMN IF NOT EXISTS seed_cohort TEXT NOT NULL DEFAULT 'seeded';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenant_bootstrap_seed_cohort_check'
  ) THEN
    ALTER TABLE oweibo.tenant_bootstrap
      ADD CONSTRAINT tenant_bootstrap_seed_cohort_check
      CHECK (seed_cohort IN ('seeded','control','exempt'))
      NOT VALID;
    ALTER TABLE oweibo.tenant_bootstrap
      VALIDATE CONSTRAINT tenant_bootstrap_seed_cohort_check;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tenant_bootstrap_seed_cohort
  ON oweibo.tenant_bootstrap (seed_cohort);

DO $$
BEGIN
  RAISE NOTICE 'T.5.e seed_cohort column installed on tenant_bootstrap.';
END;
$$;
