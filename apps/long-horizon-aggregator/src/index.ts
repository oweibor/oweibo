// D.11 — Long-horizon reward aggregator (4-hourly cron).
// Computes rolling 14-day delayed signals per (slot_id, arm_id) and upserts
// into oweibo.bandit_long_horizon. Drives beta → stable promotion eligibility.
//
// Signals (§9.2.2 two-tier reward):
//   rollback_correlation_rate  — tasks with thumbs_down / all tasks with feedback
//   post_task_edit_distance    — NULL (no diff schema; reserved for v2)
//   task_reopen_rate           — NULL (no reopen events; reserved for v2)
//   user_correction_rate       — tasks with immediate thumbs_down / all tasks
//   late_thumbs_inversion_count — thumbs_down submitted >24h after task completion

import { Pool } from 'pg';
import cron from 'node-cron';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  console.error('[long-horizon-aggregator] DATABASE_URL required');
  process.exit(1);
}

const WINDOW_DAYS  = parseInt(process.env['LONG_HORIZON_WINDOW_DAYS'] ?? '14', 10);
const CRON_EXPR   = process.env['LONG_HORIZON_CRON'] ?? '0 */4 * * *';   // every 4h

const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });

// ── Per-arm signal SQL ─────────────────────────────────────────────────────────

const COMPUTE_ARM_SIGNALS_SQL = `
WITH window_start AS (
  SELECT NOW() - ($3 || ' days')::INTERVAL AS ts
),
-- Tasks attributed to this arm via executor slot hash (best-effort match via bandit_arm_events)
arm_tasks AS (
  SELECT DISTINCT t.id, t.completed_at
  FROM oweibo.tasks t
  JOIN oweibo.bandit_arm_events bae
    ON bae.task_id::text = t.id::text
   AND bae.slot_id = $1
   AND bae.arm_id  = $2
  WHERE t.completed_at IS NOT NULL
    AND t.completed_at >= (SELECT ts FROM window_start)
),
-- Feedback joined to arm tasks
feedback AS (
  SELECT
    at.id                                              AS task_id,
    at.completed_at,
    COUNT(*) FILTER (WHERE tf.signal = 'thumbs_down') AS neg_count,
    COUNT(*) FILTER (WHERE tf.signal = 'thumbs_up')   AS pos_count,
    COUNT(*)                                           AS total_count
  FROM arm_tasks at
  LEFT JOIN oweibo.task_feedback tf ON tf.task_id = at.id
  GROUP BY at.id, at.completed_at
),
-- Late inversions: thumbs_down submitted >24h after completion
late_inversions AS (
  SELECT COUNT(*) AS cnt
  FROM arm_tasks at
  JOIN oweibo.task_feedback tf ON tf.task_id = at.id
  WHERE tf.signal = 'thumbs_down'
    AND at.completed_at IS NOT NULL
    AND tf.created_at > at.completed_at + INTERVAL '24 hours'
)
SELECT
  -- rollback_correlation_rate: thumbs_down fraction across all arm tasks with feedback
  CASE WHEN SUM(f.total_count) > 0
    THEN (SUM(f.neg_count)::NUMERIC / SUM(f.total_count))
    ELSE NULL
  END                                         AS rollback_correlation_rate,
  -- user_correction_rate: fraction of arm tasks that have any thumbs_down
  CASE WHEN COUNT(f.task_id) > 0
    THEN (COUNT(f.task_id) FILTER (WHERE f.neg_count > 0))::NUMERIC / COUNT(f.task_id)
    ELSE NULL
  END                                         AS user_correction_rate,
  -- late_thumbs_inversion_count: count of late negative flips (hard veto signal)
  (SELECT cnt FROM late_inversions)           AS late_thumbs_inversion_count
FROM feedback f;
`;

const UPSERT_SQL = `
INSERT INTO oweibo.bandit_long_horizon
  (slot_id, arm_id, window_end,
   rollback_correlation_rate, post_task_edit_distance,
   task_reopen_rate, user_correction_rate,
   late_thumbs_inversion_count, computed_at)
VALUES ($1, $2, CURRENT_DATE, $3, NULL, NULL, $4, $5, NOW())
ON CONFLICT (slot_id, arm_id, window_end) DO UPDATE SET
  rollback_correlation_rate  = EXCLUDED.rollback_correlation_rate,
  post_task_edit_distance    = NULL,
  task_reopen_rate           = NULL,
  user_correction_rate       = EXCLUDED.user_correction_rate,
  late_thumbs_inversion_count = EXCLUDED.late_thumbs_inversion_count,
  computed_at                = NOW();
`;

// ── Core aggregation ──────────────────────────────────────────────────────────

async function runAggregation(): Promise<void> {
  const startMs = Date.now();
  console.log('[long-horizon-aggregator] Starting aggregation run');

  const armsResult = await pool.query<{ arm_id: string; slot_id: string }>(
    `SELECT arm_id, slot_id FROM oweibo.bandit_arms WHERE active = true ORDER BY slot_id, arm_id`,
  );

  if (armsResult.rows.length === 0) {
    console.log('[long-horizon-aggregator] No active arms — nothing to aggregate');
    return;
  }

  let processed = 0;
  let errors    = 0;

  for (const arm of armsResult.rows) {
    try {
      const signals = await pool.query<{
        rollback_correlation_rate:   string | null;
        user_correction_rate:        string | null;
        late_thumbs_inversion_count: string | null;
      }>(COMPUTE_ARM_SIGNALS_SQL, [arm.slot_id, arm.arm_id, WINDOW_DAYS]);

      const row = signals.rows[0];
      if (!row) continue;

      const rollbackRate     = row.rollback_correlation_rate   != null ? parseFloat(row.rollback_correlation_rate)   : null;
      const correctionRate   = row.user_correction_rate        != null ? parseFloat(row.user_correction_rate)        : null;
      const lateInversions   = row.late_thumbs_inversion_count != null ? parseInt(row.late_thumbs_inversion_count, 10) : null;

      await pool.query(UPSERT_SQL, [
        arm.slot_id, arm.arm_id,
        rollbackRate, correctionRate, lateInversions,
      ]);

      processed++;
    } catch (err) {
      errors++;
      console.error(`[long-horizon-aggregator] Error processing arm ${arm.slot_id}/${arm.arm_id}:`, String(err));
    }
  }

  const elapsedMs = Date.now() - startMs;
  console.log(
    `[long-horizon-aggregator] Done: processed=${processed} errors=${errors} elapsed=${elapsedMs}ms`,
  );
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Run immediately on startup, then schedule
  await runAggregation().catch(err => {
    console.error('[long-horizon-aggregator] Startup run failed:', String(err));
  });

  cron.schedule(CRON_EXPR, () => {
    runAggregation().catch(err => {
      console.error('[long-horizon-aggregator] Scheduled run failed:', String(err));
    });
  });

  console.log(`[long-horizon-aggregator] Scheduled: "${CRON_EXPR}" (window=${WINDOW_DAYS}d)`);

  process.on('SIGTERM', async () => {
    console.log('[long-horizon-aggregator] SIGTERM — shutting down');
    await pool.end();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[long-horizon-aggregator] Fatal:', err);
  process.exit(1);
});
