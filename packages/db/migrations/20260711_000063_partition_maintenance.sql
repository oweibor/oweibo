-- K.0 follow-up (2026-07-11): the monthly-partition maintenance job that
-- 000041 promised ("subsequent months are created by a maintenance job
-- 7 days ahead of rollover") and 000062 documented as never built.
--
-- Two parts:
--
-- 1. Parent-level indexes for oweibo.action_lineage. 000041 created
--    per-child indexes on y2026m05/y2026m06 under the (mistaken) belief
--    that partitioned-parent indexes don't propagate — they do since
--    PG 11: CREATE INDEX on the parent recurses to every existing
--    partition (attaching an existing equivalent child index instead of
--    duplicating it) and auto-indexes every FUTURE partition, including
--    the ones the function below creates. audit_log already has its
--    parent index (001: idx_audit_log_tenant_ts) and needs nothing.
--
-- 2. oweibo.ensure_month_partitions(p_months_ahead): SECURITY DEFINER so
--    the app role can call it at runtime — creating a partition requires
--    ownership of the parent table, which oweibo_app deliberately lacks;
--    the function runs with its creator's (the migration role's) rights.
--    Idempotent: existing partitions report 'exists'. A month whose rows
--    already landed in the DEFAULT partition (000062) cannot be
--    retroactively partitioned without a manual row move — that month
--    reports 'skipped_default_rows' instead of erroring, and writes keep
--    flowing to the default. Run AHEAD of rollover (the cron in
--    core-engine main.ts runs daily) and this case never arises after
--    the current backlog months age out.

-- ── 1. action_lineage parent indexes ────────────────────────────────────
-- Cannot be CONCURRENTLY on a partitioned parent; fine at current scale
-- (the runner executes these outside any explicit transaction).

CREATE INDEX IF NOT EXISTS idx_action_lineage_tenant
  ON oweibo.action_lineage (tenant_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_action_lineage_plan
  ON oweibo.action_lineage (plan_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_action_lineage_parent
  ON oweibo.action_lineage (parent_node_id);

-- ── 2. the maintenance function ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION oweibo.ensure_month_partitions(p_months_ahead INT DEFAULT 2)
RETURNS TABLE (parent_table TEXT, partition_name TEXT, outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_spec        RECORD;
  v_offset      INT;
  v_month_start DATE;
  v_month_end   DATE;
  v_name        TEXT;
BEGIN
  IF p_months_ahead < 0 OR p_months_ahead > 24 THEN
    RAISE EXCEPTION 'ensure_month_partitions: p_months_ahead must be in [0, 24], got %', p_months_ahead;
  END IF;

  FOR v_spec IN
    SELECT * FROM (VALUES
      -- (parent, name pattern args are YYYY and MM strings)
      ('audit_log',      'audit_log_%s_%s'),      -- 001 naming: audit_log_2026_04
      ('action_lineage', 'action_lineage_y%sm%s') -- 000041 naming: action_lineage_y2026m05
    ) AS t(parent, pattern)
  LOOP
    FOR v_offset IN 0..p_months_ahead LOOP
      v_month_start := (date_trunc('month', now()) + make_interval(months => v_offset))::date;
      v_month_end   := (v_month_start + INTERVAL '1 month')::date;
      v_name        := format(v_spec.pattern,
                              to_char(v_month_start, 'YYYY'),
                              to_char(v_month_start, 'MM'));

      IF to_regclass(format('oweibo.%I', v_name)) IS NOT NULL THEN
        parent_table := v_spec.parent; partition_name := v_name; outcome := 'exists';
        RETURN NEXT;
        CONTINUE;
      END IF;

      BEGIN
        EXECUTE format(
          'CREATE TABLE oweibo.%I PARTITION OF oweibo.%I FOR VALUES FROM (%L) TO (%L)',
          v_name, v_spec.parent, v_month_start, v_month_end
        );
        parent_table := v_spec.parent; partition_name := v_name; outcome := 'created';
        RETURN NEXT;
      EXCEPTION
        WHEN check_violation THEN
          -- Rows for this month already sit in the DEFAULT partition
          -- (000062); carving out the dedicated partition would require
          -- moving them first. Not this function's job — report and move
          -- on; the default keeps absorbing that month's writes.
          parent_table := v_spec.parent; partition_name := v_name; outcome := 'skipped_default_rows';
          RETURN NEXT;
      END;
    END LOOP;
  END LOOP;
  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION oweibo.ensure_month_partitions(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oweibo.ensure_month_partitions(INT) TO oweibo_app;

-- Bootstrap: create the current + next 2 months right now, so the safety
-- window opens at migration time rather than at the first cron tick.
SELECT * FROM oweibo.ensure_month_partitions(2);

DO $$
BEGIN
  RAISE NOTICE 'ensure_month_partitions() installed; current+2 months ensured for audit_log and action_lineage.';
END;
$$;
