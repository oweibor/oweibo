-- Audit fixes round 4 (2026-05-28) for follow-on findings from the
-- post-S/D branch sweep:
--
--   * S.0:   action_plans.plan_cost_ceiling_usd_cents was hardcoded to
--            $500 in ActionPlanGate.loadTenantPlanCeiling. Add a nullable
--            per-tenant column so operators can override without changing
--            code.
--   * D.6:   add a foreign key from tenant_domain_binding.domain_slug to
--            domain_registry.slug so the DB also rejects typo'd slugs
--            even if the service-layer check is bypassed (e.g. ad-hoc SQL
--            admin scripts).
--
-- Each section is idempotent (`IF NOT EXISTS` / conditional DO blocks).

BEGIN;

-- ── S.0: per-tenant plan cost ceiling override ──────────────────────────
ALTER TABLE oweibo.tenants
  ADD COLUMN IF NOT EXISTS plan_cost_ceiling_usd_cents INTEGER;

COMMENT ON COLUMN oweibo.tenants.plan_cost_ceiling_usd_cents IS
  'Per-tenant override for ActionPlanGate plan-budget ceiling (USD cents). NULL ⇒ use platform default.';

-- Sanity bound: a negative ceiling is meaningless and would block every
-- plan. Allow NULL and any non-negative integer.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tenants_plan_cost_ceiling_nonneg'
       AND conrelid = 'oweibo.tenants'::regclass
  ) THEN
    ALTER TABLE oweibo.tenants
      ADD CONSTRAINT tenants_plan_cost_ceiling_nonneg
        CHECK (plan_cost_ceiling_usd_cents IS NULL OR plan_cost_ceiling_usd_cents >= 0);
  END IF;
END $$;

-- ── D.6: FK on tenant_domain_binding.domain_slug → domain_catalog ──────
-- The TenantDomainBindingService now validates slugs against the
-- registry at write time, but the DB had no constraint — ad-hoc SQL
-- could still create dead bindings. Add the FK so unknown slugs are
-- rejected by the database itself.
--
-- Defect fix (2026-07-10): the registry table is oweibo.domain_catalog
-- (created by 000032), not oweibo.domain_registry. The original name made
-- this migration unappliable on any database, so no environment has the FK
-- or the S.0 column above — the correction is compat-safe by construction.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tenant_domain_binding_slug_fkey'
       AND conrelid = 'oweibo.tenant_domain_binding'::regclass
  ) THEN
    -- Defensive: remove any existing dead bindings before adding the FK.
    -- Should be a no-op in environments where the service has been the
    -- only writer.
    DELETE FROM oweibo.tenant_domain_binding b
     WHERE NOT EXISTS (
       SELECT 1 FROM oweibo.domain_catalog r WHERE r.slug = b.domain_slug
     );
    ALTER TABLE oweibo.tenant_domain_binding
      ADD CONSTRAINT tenant_domain_binding_slug_fkey
        FOREIGN KEY (domain_slug) REFERENCES oweibo.domain_catalog(slug)
          ON DELETE RESTRICT;
  END IF;
END $$;

COMMIT;

DO $$
BEGIN
  RAISE NOTICE 'Audit fixes round 4 applied: plan_cost_ceiling_usd_cents column + tenant_domain_binding FK.';
END;
$$;
