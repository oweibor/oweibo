-- S.0 (ttv-action-safety-v2): Action lineage, plan-level approval, blast-radius.
--
-- Three new objects:
--   1. oweibo.action_plans — multi-action plans with shared approval state
--   2. ALTER oweibo.action_proposals — add plan_id + step membership cols
--   3. oweibo.action_lineage — append-only audit tree, partitioned by month
--
-- Pre-flight: requires ttv.md T.−1 migration (20260520_000024) to have run,
-- since action_proposals must exist before we ALTER it.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'oweibo' AND table_name = 'action_proposals'
  ) THEN
    RAISE EXCEPTION 'S.0 migration requires ttv.md T.−1 (action_proposals) to be applied first.';
  END IF;
END $$;

BEGIN;

-- ── action_plans ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oweibo.action_plans (
  id                         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  user_id                    UUID,
  originating_task_id        UUID,
  title                      TEXT         NOT NULL,
  atomicity                  TEXT         NOT NULL,
  state                      TEXT         NOT NULL DEFAULT 'pending',
  worst_reversibility        TEXT         NOT NULL,
  systems                    TEXT[]       NOT NULL DEFAULT '{}',
  data_domains               TEXT[]       NOT NULL DEFAULT '{}',
  estimated_cost_usd_cents   INTEGER      NOT NULL DEFAULT 0,
  estimated_reach_user_count INTEGER      NOT NULL DEFAULT 0,
  plan_proposal_id           UUID,
  created_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  started_at                 TIMESTAMPTZ,
  completed_at               TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'action_plans_atomicity_check') THEN
    ALTER TABLE oweibo.action_plans
      ADD CONSTRAINT action_plans_atomicity_check
      CHECK (atomicity IN ('all_or_nothing','best_effort','sequential_with_checkpoints'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'action_plans_state_check') THEN
    ALTER TABLE oweibo.action_plans
      ADD CONSTRAINT action_plans_state_check
      CHECK (state IN ('pending','running','partial','succeeded','failed','rolled_back','aborted'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'action_plans_reversibility_check') THEN
    ALTER TABLE oweibo.action_plans
      ADD CONSTRAINT action_plans_reversibility_check
      CHECK (worst_reversibility IN ('trivial','reversible_with_cost','irreversible'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'action_plans_plan_proposal_fk'
  ) THEN
    ALTER TABLE oweibo.action_plans
      ADD CONSTRAINT action_plans_plan_proposal_fk
      FOREIGN KEY (plan_proposal_id) REFERENCES oweibo.action_proposals(id);
  END IF;
END $$;

ALTER TABLE oweibo.action_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.action_plans FORCE ROW LEVEL SECURITY;

CREATE POLICY action_plans_tenant_isolation
  ON oweibo.action_plans
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY action_plans_platform_admin
  ON oweibo.action_plans
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE ON oweibo.action_plans TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_action_plans_tenant_state
  ON oweibo.action_plans (tenant_id, state, created_at DESC);

-- ── action_proposals: add plan membership columns ─────────────────────────
ALTER TABLE oweibo.action_proposals
  ADD COLUMN IF NOT EXISTS plan_id                   UUID REFERENCES oweibo.action_plans(id),
  ADD COLUMN IF NOT EXISTS step_number               INTEGER,
  ADD COLUMN IF NOT EXISTS depends_on_steps          INTEGER[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS blast_radius_contribution JSONB;

CREATE INDEX IF NOT EXISTS idx_action_proposals_plan
  ON oweibo.action_proposals (plan_id, step_number);

COMMIT;

-- ── action_lineage (partitioned by recorded_at) ───────────────────────────
-- Partition routing requires recorded_at in the PK. Parent table is empty;
-- all rows land in child partitions created per-month.

BEGIN;

CREATE TABLE IF NOT EXISTS oweibo.action_lineage (
  id              UUID         NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES oweibo.tenants(id) ON DELETE CASCADE,
  plan_id         UUID         NOT NULL REFERENCES oweibo.action_plans(id) ON DELETE CASCADE,
  parent_node_id  UUID,
  kind            TEXT         NOT NULL,
  producer_type   TEXT         NOT NULL,
  producer_id     TEXT         NOT NULL,
  summary         TEXT         NOT NULL,
  detail          JSONB        NOT NULL,
  trace_id        TEXT,
  recorded_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, recorded_at)
) PARTITION BY RANGE (recorded_at);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'action_lineage_kind_check') THEN
    ALTER TABLE oweibo.action_lineage
      ADD CONSTRAINT action_lineage_kind_check
      CHECK (kind IN (
        'goal_decomposition','agent_decision','tool_invocation',
        'gate_decision','execution','verification','rollback'
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'action_lineage_producer_check') THEN
    ALTER TABLE oweibo.action_lineage
      ADD CONSTRAINT action_lineage_producer_check
      CHECK (producer_type IN ('agent','gate','human'));
  END IF;
END $$;

ALTER TABLE oweibo.action_lineage ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.action_lineage FORCE ROW LEVEL SECURITY;

CREATE POLICY action_lineage_tenant_isolation
  ON oweibo.action_lineage
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY action_lineage_platform_admin
  ON oweibo.action_lineage
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT ON oweibo.action_lineage TO oweibo_app;

-- First child partition (current month — 2026-05). Subsequent months are
-- created by a maintenance job 7 days ahead of rollover.
CREATE TABLE IF NOT EXISTS oweibo.action_lineage_y2026m05
  PARTITION OF oweibo.action_lineage
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE TABLE IF NOT EXISTS oweibo.action_lineage_y2026m06
  PARTITION OF oweibo.action_lineage
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- Per-partition indexes (parent-table indexes are NOT auto-inherited for
-- partitioned tables; each child gets its own).
CREATE INDEX IF NOT EXISTS idx_action_lineage_y2026m05_tenant
  ON oweibo.action_lineage_y2026m05 (tenant_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_action_lineage_y2026m05_plan
  ON oweibo.action_lineage_y2026m05 (plan_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_action_lineage_y2026m05_parent
  ON oweibo.action_lineage_y2026m05 (parent_node_id);

CREATE INDEX IF NOT EXISTS idx_action_lineage_y2026m06_tenant
  ON oweibo.action_lineage_y2026m06 (tenant_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_action_lineage_y2026m06_plan
  ON oweibo.action_lineage_y2026m06 (plan_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_action_lineage_y2026m06_parent
  ON oweibo.action_lineage_y2026m06 (parent_node_id);

COMMIT;

DO $$
BEGIN
  RAISE NOTICE 'S.0 action_plans + action_lineage installed (monthly partitions for 2026-05/06).';
END;
$$;
