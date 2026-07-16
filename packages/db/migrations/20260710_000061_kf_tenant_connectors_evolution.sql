-- K.0 (knowledge fabric): tenant_connectors evolution — D.4 catalog model →
-- manifest/adapter model. ADR-000 §3.3 (Ratified): ADDITIVE ONLY — every
-- column nullable-or-defaulted so pre-fabric code paths ignore them and older
-- deployments still boot. "Rollback" = stop reading the new columns; never a
-- down-migration. A column may become NOT NULL only after a verified backfill
-- and only as a breaking change under §10.3 (ADR-000 §3.3 rollback posture).
--
-- Two tier axes (ADR-012 §3.4, never merged): the catalog's certification
-- tier stays in the catalog entry (code trust); enablement_tier below is the
-- tenant's install decision (0/1/2; Tier-2 requires the cost/scope
-- confirmation step, §10.4).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'oweibo' AND table_name = 'tenant_connectors'
      AND column_name = 'manifest_version'
  ) THEN
    ALTER TABLE oweibo.tenant_connectors ADD COLUMN manifest_version TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'oweibo' AND table_name = 'tenant_connectors'
      AND column_name = 'sync_mode'
  ) THEN
    ALTER TABLE oweibo.tenant_connectors ADD COLUMN sync_mode TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'oweibo' AND table_name = 'tenant_connectors'
      AND column_name = 'enablement_tier'
  ) THEN
    ALTER TABLE oweibo.tenant_connectors ADD COLUMN enablement_tier SMALLINT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'oweibo' AND table_name = 'tenant_connectors'
      AND column_name = 'health_state'
  ) THEN
    ALTER TABLE oweibo.tenant_connectors ADD COLUMN health_state TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'oweibo' AND table_name = 'tenant_connectors'
      AND column_name = 'data_residency'
  ) THEN
    ALTER TABLE oweibo.tenant_connectors ADD COLUMN data_residency TEXT;
  END IF;

  -- Effective capability subset for this instance (ADR-012 §3.3 maximum-vs-
  -- effective): populated by validateConnection at install, re-checked by
  -- health probes. NULL = not yet validated.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'oweibo' AND table_name = 'tenant_connectors'
      AND column_name = 'effective_capabilities'
  ) THEN
    ALTER TABLE oweibo.tenant_connectors ADD COLUMN effective_capabilities JSONB;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_connectors_enablement_tier_check'
  ) THEN
    ALTER TABLE oweibo.tenant_connectors
      ADD CONSTRAINT tenant_connectors_enablement_tier_check
      CHECK (enablement_tier IS NULL OR enablement_tier BETWEEN 0 AND 2);
  END IF;
END $$;

DO $$
BEGIN
  RAISE NOTICE 'K.0 tenant_connectors evolution (additive) installed.';
END;
$$;
