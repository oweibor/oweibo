-- T.3.a: Aggregated cross-tenant priors for bandit cold-start.
--
-- Populated nightly by apps/platform-priors-aggregator. Each row records
-- alpha_sum + beta_sum aggregated across tenants whose contributing arms
-- pass the same K-anonymity gate (>= 5 distinct tenants) used for the
-- pattern bank. BanditService.loadArms() consults this table when no
-- per-(slot, channel) arm exists yet; the synthetic arm seeds the cold-
-- start tenant with a non-uniform prior instead of Beta(1,1).
--
-- Cross-tenant catalog (no tenant_id). Tenants read; only the
-- platform_priors_writer role writes. The writer role is opt-in: when the
-- aggregator app is deployed it is granted the role; production DBs that
-- skip the aggregator simply leave the table empty (BanditService falls
-- through to Beta(1,1), today's behaviour).

CREATE TABLE IF NOT EXISTS oweibo.platform_bandit_priors (
  scope_kind        TEXT          NOT NULL,
  scope_key         TEXT          NOT NULL,
  -- For prompt_slot: scope_key = role || ':' || slot_id || ':' || channel
  -- For model_tier:  scope_key = category || ':' || tier || ':' || model_id
  alpha_sum         NUMERIC(14,4) NOT NULL,
  beta_sum          NUMERIC(14,4) NOT NULL,
  contributor_count INTEGER       NOT NULL,
  computed_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  catalog_version   TEXT          NOT NULL,
  PRIMARY KEY (scope_kind, scope_key)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'platform_bandit_priors_scope_kind_check'
  ) THEN
    ALTER TABLE oweibo.platform_bandit_priors
      ADD CONSTRAINT platform_bandit_priors_scope_kind_check
      CHECK (scope_kind IN ('prompt_slot','model_tier'))
      NOT VALID;
    ALTER TABLE oweibo.platform_bandit_priors
      VALIDATE CONSTRAINT platform_bandit_priors_scope_kind_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'platform_bandit_priors_alpha_pos'
  ) THEN
    ALTER TABLE oweibo.platform_bandit_priors
      ADD CONSTRAINT platform_bandit_priors_alpha_pos
      CHECK (alpha_sum > 0 AND beta_sum > 0 AND contributor_count >= 5)
      NOT VALID;
    ALTER TABLE oweibo.platform_bandit_priors
      VALIDATE CONSTRAINT platform_bandit_priors_alpha_pos;
  END IF;
END $$;

GRANT SELECT ON oweibo.platform_bandit_priors TO oweibo_app;

-- Writer role: only the aggregator service is granted this role. NOINHERIT
-- so cross-role privilege creep is blocked. CREATE ROLE IF NOT EXISTS is
-- not standard SQL; use the DO-block guard.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_priors_writer') THEN
    CREATE ROLE platform_priors_writer NOINHERIT;
  END IF;
END $$;

GRANT INSERT, UPDATE, DELETE ON oweibo.platform_bandit_priors TO platform_priors_writer;

CREATE INDEX IF NOT EXISTS idx_platform_bandit_priors_computed_at
  ON oweibo.platform_bandit_priors (computed_at DESC);

DO $$
BEGIN
  RAISE NOTICE 'T.3.a platform_bandit_priors installed.';
END;
$$;
