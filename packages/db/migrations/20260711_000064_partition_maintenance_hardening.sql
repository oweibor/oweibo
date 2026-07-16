-- Hardening revision of 000063's oweibo.ensure_month_partitions().
-- Same contract, three edge cases closed (000063 is already applied in
-- environments, so this ships as CREATE OR REPLACE rather than an edit):
--
--   1. Concurrency (TOCTOU): two callers — cron ticks on two replicas,
--      or a manual psql call racing the cron — can both pass the
--      to_regclass existence check; the loser's CREATE TABLE then raised
--      an uncaught duplicate_table error that aborted the whole call.
--      Now caught → outcome 'exists'. (The runtime advisory lock only
--      de-dupes the cron; the function itself must be race-safe.)
--
--   2. Lock stalls: CREATE TABLE ... PARTITION OF needs an exclusive
--      lock that can queue indefinitely behind write traffic touching
--      the DEFAULT partition — and every statement queued behind *us*
--      then waits too. A maintenance job must fail fast and retry next
--      tick, never stall the write path: lock_timeout '5s' is set for
--      the function's duration, and a timeout reports
--      'skipped_lock_timeout' instead of erroring.
--
--   3. NULL horizon: ensure_month_partitions(NULL) slipped past the
--      range check (NULL < 0 is NULL, not true) and died with an
--      obscure "lower bound of FOR loop cannot be null". Now rejected
--      explicitly.

CREATE OR REPLACE FUNCTION oweibo.ensure_month_partitions(p_months_ahead INT DEFAULT 2)
RETURNS TABLE (parent_table TEXT, partition_name TEXT, outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $$
DECLARE
  v_spec        RECORD;
  v_offset      INT;
  v_month_start DATE;
  v_month_end   DATE;
  v_name        TEXT;
BEGIN
  IF p_months_ahead IS NULL OR p_months_ahead < 0 OR p_months_ahead > 24 THEN
    RAISE EXCEPTION 'ensure_month_partitions: p_months_ahead must be in [0, 24], got %',
      COALESCE(p_months_ahead::text, 'NULL');
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
        WHEN duplicate_table THEN
          -- Lost a create race to a concurrent caller — the partition is
          -- there, which is all we wanted.
          parent_table := v_spec.parent; partition_name := v_name; outcome := 'exists';
          RETURN NEXT;
        WHEN lock_not_available THEN
          -- Couldn't get the exclusive lock within lock_timeout. Never
          -- stall the write path for maintenance — the next daily tick
          -- (or the boot tick) retries.
          parent_table := v_spec.parent; partition_name := v_name; outcome := 'skipped_lock_timeout';
          RETURN NEXT;
      END;
    END LOOP;
  END LOOP;
  RETURN;
END;
$$;

-- CREATE OR REPLACE preserves the 000063 ACL, but re-affirm for
-- self-containedness (a fresh DB replays 63 then 64; both end here).
REVOKE ALL ON FUNCTION oweibo.ensure_month_partitions(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oweibo.ensure_month_partitions(INT) TO oweibo_app;

-- Smoke the replaced function.
SELECT * FROM oweibo.ensure_month_partitions(2);

DO $$
BEGIN
  RAISE NOTICE 'ensure_month_partitions() hardened (race-safe, lock_timeout, NULL horizon rejected).';
END;
$$;
