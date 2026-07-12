-- K.2 (ADR-010 §3.4/§3.6, ratified 2026-07-11): kf_principal_seeds — the
-- canonical identity SEED records the IdP connector materializes at
-- bootstrap ("Canonical identity seed records (IdP-only)", roadmap K.2).
--
-- Schema-governance note: this table is derived from the ratified full
-- ADR-010, not from a pre-K.0 schema chapter — §3.4 fixes "the IdP's
-- verified email is the only cross-source seed (Experimental — ADR-002
-- replaces this wholesale at K.8)". Columns are deliberately minimal and
-- mirror the SDK's SourcePrincipal shape 1:1.
--
-- What is NEVER stored here (same clause discipline as
-- kf_membership_records): no canonical_user_id, no confidence, no
-- resolution state, no merge decisions — every one of those is Identity
-- Resolution's (ADR-002, K.8). This table is raw per-source principal
-- observations plus the one sanctioned seed field (verified email).
--
-- Tenant-scoped per ADR-000 §3.4: FORCE RLS + tenant_isolation; enters
-- the kf-store-scope manifest (entry per table).

CREATE TABLE IF NOT EXISTS oweibo.kf_principal_seeds (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  source          TEXT         NOT NULL,
  principal_ref   TEXT         NOT NULL,
  -- Verified email only — NULL when the source would not stand behind it.
  verified_email  TEXT,
  display_name    TEXT,
  status          TEXT         NOT NULL DEFAULT 'active',
  observed_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kf_principal_seeds_unique_principal'
  ) THEN
    ALTER TABLE oweibo.kf_principal_seeds
      ADD CONSTRAINT kf_principal_seeds_unique_principal
      UNIQUE (tenant_id, source, principal_ref);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kf_principal_seeds_status_check'
  ) THEN
    ALTER TABLE oweibo.kf_principal_seeds
      ADD CONSTRAINT kf_principal_seeds_status_check
      CHECK (status IN ('active', 'suspended', 'deleted'));
  END IF;
END $$;

ALTER TABLE oweibo.kf_principal_seeds ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.kf_principal_seeds FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oweibo.kf_principal_seeds;
CREATE POLICY tenant_isolation ON oweibo.kf_principal_seeds
  FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON oweibo.kf_principal_seeds TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_kf_principal_seeds_email
  ON oweibo.kf_principal_seeds (tenant_id, verified_email)
  WHERE verified_email IS NOT NULL;

DO $$
BEGIN
  RAISE NOTICE 'K.2 kf_principal_seeds installed.';
END;
$$;
