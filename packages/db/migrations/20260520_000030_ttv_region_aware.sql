-- T.8: Region-aware seeds, priors, and lesson recall.
--
-- Adds `home_region` to oweibo.platform_lessons (NULLable: pre-T.8 rows are
-- treated as region-neutral fallback) and oweibo.platform_bandit_priors
-- (NOT NULL DEFAULT '*': pre-existing rows are explicitly platform-neutral).
--
-- platform_bandit_priors PRIMARY KEY widens from (scope_kind, scope_key) to
-- (scope_kind, scope_key, home_region) so per-region rows coexist with the
-- '*' fallback row. The PK swap is done via CREATE INDEX CONCURRENTLY +
-- ALTER TABLE … USING INDEX to avoid an ACCESS EXCLUSIVE rebuild — the table
-- is read on every task execution via BanditService.loadArms() and a naive
-- DROP/ADD CONSTRAINT would block readers during the rebuild.
--
-- Multi-statement migration. The CONCURRENTLY index build is unsafe inside a
-- transaction; the runner honors the `-- @no-transaction` marker below to
-- execute Section B as a bare statement.

-- ── Section A: additive column changes (transactional) ─────────────────────
BEGIN;

ALTER TABLE oweibo.platform_lessons
  ADD COLUMN IF NOT EXISTS home_region TEXT;

CREATE INDEX IF NOT EXISTS idx_platform_lessons_region
  ON oweibo.platform_lessons (home_region, bucket_key);

ALTER TABLE oweibo.platform_bandit_priors
  ADD COLUMN IF NOT EXISTS home_region TEXT NOT NULL DEFAULT '*';

COMMIT;

-- ── Section B: build replacement unique index without blocking readers ─────
-- Must run OUTSIDE a transaction (Postgres requirement for CONCURRENTLY).

-- @no-transaction
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS platform_bandit_priors_pkey_new
  ON oweibo.platform_bandit_priors (scope_kind, scope_key, home_region);

-- ── Section C: swap the primary key (transactional, metadata-only) ─────────
-- ALTER TABLE … USING INDEX swaps the constraint to point at the pre-built
-- index. Brief ACCESS EXCLUSIVE lock for the swap; does NOT rebuild data.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_bandit_priors_pkey'
      AND conrelid = 'oweibo.platform_bandit_priors'::regclass
  ) THEN
    ALTER TABLE oweibo.platform_bandit_priors
      DROP CONSTRAINT platform_bandit_priors_pkey;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'oweibo'
      AND indexname  = 'platform_bandit_priors_pkey_new'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_bandit_priors_pkey'
      AND conrelid = 'oweibo.platform_bandit_priors'::regclass
  ) THEN
    ALTER TABLE oweibo.platform_bandit_priors
      ADD CONSTRAINT platform_bandit_priors_pkey
      PRIMARY KEY USING INDEX platform_bandit_priors_pkey_new;
  END IF;
END $$;

COMMIT;

DO $$
BEGIN
  RAISE NOTICE 'T.8 region_aware columns installed (lessons.home_region nullable; priors.home_region default *).';
END;
$$;
