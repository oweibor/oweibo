-- Migration: Phase D.12 — Mutation-status governance + RFC tooling.
-- Closes audit-3 #11 (slot mutation-freeze policy).
-- Requires: 20260508_000001_phase_c_gepa.sql already applied.

-- ── oweibo.prompt_slot_mutation_history ──────────────────────────────────────
-- Immutable audit log of all mutation_status transitions on prompt_versions.
-- Every freeze/guard/unfreeze command writes here in addition to updating
-- the prompt_versions row.

CREATE TABLE IF NOT EXISTS oweibo.prompt_slot_mutation_history (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id         TEXT        NOT NULL,
  role            TEXT        NOT NULL,
  previous_status TEXT        NOT NULL,
  new_status      TEXT        NOT NULL
                              CHECK (new_status IN ('mutable', 'guarded', 'frozen', 'stable')),
  reason          TEXT        NOT NULL,
  rfc_url         TEXT,       -- link to the Mutation-Freeze RFC (required for 'frozen')
  changed_by      TEXT        NOT NULL,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mutation_history_slot
  ON oweibo.prompt_slot_mutation_history (slot_id, role, changed_at DESC);

GRANT SELECT, INSERT ON oweibo.prompt_slot_mutation_history TO oweibo_app;

-- ── Initial D.12 state per §7.4.3 ────────────────────────────────────────────
-- Set canonical mutation_status for all prompt_versions that exist at Phase D entry.
-- 'mutable' roles: architect decomposition_rules, executor tool_arg_construction,
--                  reviewer severity_rubric (evolved slots with signal)
-- 'frozen' roles: domain-specialist (generic_domain_directive) per audit-9 resolution

-- Seed history entries for the initial state transitions
-- (only if prompt_versions rows exist — skipped silently if not)
DO $$
BEGIN
  -- Mark any domain-specialist slots as frozen (audit-9 resolution)
  UPDATE oweibo.prompt_versions
    SET mutation_status = 'frozen',
        freeze_reason   = 'audit-9: role exists in code but evolution surface undefined; needs RFC before un-freezing'
  WHERE role = 'domain-specialist' AND mutation_status = 'stable';

  -- Record history for the above
  INSERT INTO oweibo.prompt_slot_mutation_history
    (slot_id, role, previous_status, new_status, reason, changed_by)
  SELECT slot_id, role, 'stable', 'frozen',
    'audit-9: domain-specialist slots frozen at Phase D entry',
    'migration:d12'
  FROM oweibo.prompt_versions
  WHERE role = 'domain-specialist' AND mutation_status = 'frozen'
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'Phase D.12 mutation governance schema applied.';
END;
$$;
