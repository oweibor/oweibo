-- Migration: Phase A foundations — prompt versioning, cohort channels, tasks table
-- DONE: Phase A.2
-- Requires: 001_initial_schema.sql already applied.

-- ── oweibo.tasks ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.tasks (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID        NOT NULL REFERENCES oweibo.tenants(id),
  user_id                   UUID        REFERENCES oweibo.users(id),
  session_id                TEXT,
  task_mode                 TEXT        NOT NULL DEFAULT 'factory'
                                        CHECK (task_mode IN ('factory', 'general-coding')),
  goal_description          TEXT        NOT NULL,
  goal_context              TEXT,
  repo_path                 TEXT,
  status                    TEXT        NOT NULL DEFAULT 'pending'
                                        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  result                    JSONB,
  error                     TEXT,
  tokens_used               INTEGER     NOT NULL DEFAULT 0,
  ttl_seconds               INTEGER,
  -- Phase A: prompt-version pinning columns (§9.3)
  architect_assembled_hash  TEXT,
  executor_assembled_hash   TEXT,
  reviewer_assembled_hash   TEXT,
  decomposer_assembled_hash TEXT,
  slot_pin_detail           JSONB,
  cohort_channel            TEXT        NOT NULL DEFAULT 'stable',
  project_id                UUID,
  -- timestamps
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at                TIMESTAMPTZ,
  completed_at              TIMESTAMPTZ
);

ALTER TABLE oweibo.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.tasks FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON oweibo.tasks
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY platform_admin_bypass ON oweibo.tasks
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE ON oweibo.tasks TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_tasks_tenant_status   ON oweibo.tasks (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant_created  ON oweibo.tasks (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_cohort_channel  ON oweibo.tasks (cohort_channel);

-- ── oweibo.tenant_settings ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.tenant_settings (
  tenant_id                         UUID        PRIMARY KEY REFERENCES oweibo.tenants(id),
  participate_in_pattern_bank       BOOLEAN     NOT NULL DEFAULT false,
  pattern_bank_enabled_at           TIMESTAMPTZ,
  pattern_bank_eligibility_checked_at TIMESTAMPTZ,
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE oweibo.tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.tenant_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON oweibo.tenant_settings
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY platform_admin_bypass ON oweibo.tenant_settings
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE ON oweibo.tenant_settings TO oweibo_app;

-- ── oweibo.prompt_versions ─────────────────────────────────────────────────
-- Content-addressed store. hash = SHA256(role || ':' || slot_id || ':' || template_version || ':' || text)
-- GEPA writes here via gepa_optimizer_role (granted in Phase B migration).

CREATE TABLE IF NOT EXISTS oweibo.prompt_versions (
  hash              TEXT        PRIMARY KEY,
  role              TEXT        NOT NULL,
  slot_id           TEXT        NOT NULL,
  template_version  TEXT        NOT NULL DEFAULT 'stable-v0',
  text              TEXT        NOT NULL,
  parent_hash       TEXT        REFERENCES oweibo.prompt_versions(hash),
  mutation_status   TEXT        NOT NULL DEFAULT 'stable'
                                CHECK (mutation_status IN (
                                  'stable', 'fast', 'beta', 'guarded',
                                  'frozen', 'pending_human_review', 'retired'
                                )),
  freeze_reason     TEXT,
  eval_score        JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by        TEXT
);

-- No RLS — platform-wide table; access controlled by Postgres role grants.
GRANT SELECT ON oweibo.prompt_versions TO oweibo_app;
-- INSERT/UPDATE granted to gepa_optimizer_role in Phase B migration.
-- For now, allow oweibo_app to insert (seed only path).
GRANT INSERT, UPDATE ON oweibo.prompt_versions TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_prompt_versions_role_slot
  ON oweibo.prompt_versions (role, slot_id);
CREATE INDEX IF NOT EXISTS idx_prompt_versions_parent
  ON oweibo.prompt_versions (parent_hash)
  WHERE parent_hash IS NOT NULL;

-- ── oweibo.channels ────────────────────────────────────────────────────────
-- Per-role, per-slot channel pointer with optimistic-lock version column.
-- CohortRouter reads this; auto-rollback flips prompt_hash here.

CREATE TABLE IF NOT EXISTS oweibo.channels (
  name         TEXT        NOT NULL,   -- 'stable-v0', 'stable', 'beta', 'fast'
  role         TEXT        NOT NULL,
  slot_id      TEXT        NOT NULL,
  prompt_hash  TEXT        NOT NULL REFERENCES oweibo.prompt_versions(hash),
  version      BIGINT      NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   TEXT,
  PRIMARY KEY (name, role, slot_id)
);

GRANT SELECT, INSERT, UPDATE ON oweibo.channels TO oweibo_app;

-- ── oweibo.task_feedback ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oweibo.task_feedback (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    UUID        NOT NULL REFERENCES oweibo.tasks(id),
  tenant_id  UUID        NOT NULL REFERENCES oweibo.tenants(id),
  user_id    UUID        REFERENCES oweibo.users(id),
  signal     TEXT        NOT NULL CHECK (signal IN ('thumbs_up', 'thumbs_down')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE oweibo.task_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.task_feedback FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON oweibo.task_feedback
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE POLICY platform_admin_bypass ON oweibo.task_feedback
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT ON oweibo.task_feedback TO oweibo_app;

CREATE INDEX IF NOT EXISTS idx_task_feedback_task ON oweibo.task_feedback (task_id);

-- ── Seed stable-v0 ─────────────────────────────────────────────────────────
-- One row per (role, slot_id) using SHA256(role:slot_id:stable-v0:text).
-- Static prompt text sourced from BaseAgent.ts and GoalDecomposer.ts.
-- A.5 will replace placeholder slots with properly segmented template content.

DO $$
DECLARE
  v_hash TEXT;

  -- Current static prompts (BaseAgent.ts / GoalDecomposer.ts)
  t_architect  TEXT := 'You are the Architect agent. Decompose goals into a precise, ordered plan.';
  t_executor   TEXT := 'You are the Executor agent. Carry out plan steps faithfully and report results.';
  t_reviewer   TEXT := 'You are the Reviewer agent. Audit executor outputs and challenge defects.';
  t_decomposer TEXT := 'You are a task decomposer. Break a software goal into ordered sub-goals. Each sub-goal has: description, toolName (optional), input (optional object), dependsOn (array of descriptions it depends on). Output JSON array only.';

  -- Slot layout (§7.3). stable-v0 puts the full static prompt in the primary slot;
  -- secondary slots are empty strings and not referenced by the v0 frame template.
  slots TEXT[][] := ARRAY[
    -- role,          slot_id,                     text
    ARRAY['architect',  'decomposition_rules',        NULL],  -- filled below
    ARRAY['architect',  'tool_selection_rubric',      ''],
    ARRAY['architect',  'error_recovery_template',    ''],
    ARRAY['executor',   'tool_arg_construction',      NULL],
    ARRAY['executor',   'intermediate_state_check',   ''],
    ARRAY['executor',   'failure_handling',            ''],
    ARRAY['reviewer',   'defect_taxonomy',             NULL],
    ARRAY['reviewer',   'severity_rubric',             ''],
    ARRAY['reviewer',   'acceptance_criteria',         ''],
    ARRAY['decomposer', 'subgoal_granularity_guide',  NULL],
    ARRAY['decomposer', 'dependency_inference_rules', '']
  ];

  i INTEGER;
  v_role TEXT;
  v_slot TEXT;
  v_text TEXT;
BEGIN
  -- Patch NULL entries with actual static text
  slots[1][3]  := t_architect;
  slots[4][3]  := t_executor;
  slots[7][3]  := t_reviewer;
  slots[10][3] := t_decomposer;

  FOR i IN 1 .. array_length(slots, 1) LOOP
    v_role := slots[i][1];
    v_slot := slots[i][2];
    v_text := slots[i][3];

    v_hash := encode(
      sha256((v_role || ':' || v_slot || ':stable-v0:' || v_text)::bytea),
      'hex'
    );

    INSERT INTO oweibo.prompt_versions
      (hash, role, slot_id, template_version, text, mutation_status)
    VALUES
      (v_hash, v_role, v_slot, 'stable-v0', v_text, 'stable')
    ON CONFLICT (hash) DO NOTHING;

    -- Channel pointer: both 'stable-v0' and 'stable' start at v0 hashes
    INSERT INTO oweibo.channels (name, role, slot_id, prompt_hash)
    VALUES ('stable-v0', v_role, v_slot, v_hash)
    ON CONFLICT (name, role, slot_id) DO UPDATE SET prompt_hash = EXCLUDED.prompt_hash;

    INSERT INTO oweibo.channels (name, role, slot_id, prompt_hash)
    VALUES ('stable', v_role, v_slot, v_hash)
    ON CONFLICT (name, role, slot_id) DO UPDATE SET prompt_hash = EXCLUDED.prompt_hash;
  END LOOP;
END;
$$;
