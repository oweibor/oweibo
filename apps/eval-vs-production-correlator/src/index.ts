// D.15 — Eval-vs-production correlation gauge (§8.3.4 / audit-11).
// Daily cron: for each active slot, compute Spearman ρ between
// eval-suite composite scores and online bandit reward over a rolling
// 30-day window, storing one row per slot per day in
// oweibo.eval_production_correlation.
//
// Alert condition: ρ < 0.4 sustained ≥7 days → flag the slot, page charter.
// This is a read-only diagnostic — the GEPA loop never reads this table.

import { Pool }  from 'pg';
import cron      from 'node-cron';

// ── Config ────────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  console.error('[eval-correlator] DATABASE_URL required');
  process.exit(1);
}

const CRON_EXPR       = process.env['EVAL_CORR_CRON']           ?? '0 2 * * *';   // daily 02:00
const WINDOW_DAYS     = parseInt(process.env['EVAL_CORR_WINDOW']  ?? '30', 10);
const LOW_RHO_THRESH  = parseFloat(process.env['LOW_RHO_THRESH']  ?? '0.4');
const FLAG_DAYS       = parseInt(process.env['FLAG_DAYS']          ?? '7', 10);

const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });

// ── Spearman ρ ────────────────────────────────────────────────────────────────

/** Rank array in ascending order. Ties get the average rank. */
function rank(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);

  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j < indexed.length - 1 && indexed[j + 1]!.v === indexed[j]!.v) j++;
    const avgRank = (i + j) / 2 + 1;   // 1-based average rank
    for (let k = i; k <= j; k++) ranks[indexed[k]!.i] = avgRank;
    i = j + 1;
  }
  return ranks;
}

/** Spearman ρ = Pearson correlation of ranks. Returns NaN if n < 2. */
function spearman(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n !== ys.length || n < 2) return NaN;

  const rx = rank(xs);
  const ry = rank(ys);

  // Pearson on ranks
  const mx = rx.reduce((s, v) => s + v, 0) / n;
  const my = ry.reduce((s, v) => s + v, 0) / n;

  let num = 0; let dx2 = 0; let dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dxi = rx[i]! - mx;
    const dyi = ry[i]! - my;
    num  += dxi * dyi;
    dx2  += dxi * dxi;
    dy2  += dyi * dyi;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}

// ── Per-slot computation SQL ──────────────────────────────────────────────────

const SLOT_SCORES_SQL = `
WITH window_start AS (
  SELECT NOW() - ($2 || ' days')::INTERVAL AS ts
),
-- Mean bandit reward per arm over the window
arm_rewards AS (
  SELECT
    ba.arm_id,
    ba.slot_id,
    ba.prompt_hash,
    AVG(bae.reward)::DOUBLE PRECISION AS mean_reward,
    COUNT(bae.task_id)               AS event_count
  FROM oweibo.bandit_arms ba
  JOIN oweibo.bandit_arm_events bae
    ON bae.arm_id  = ba.arm_id
   AND bae.slot_id = ba.slot_id
  WHERE ba.slot_id  = $1
    AND ba.active   = true
    AND bae.recorded_at >= (SELECT ts FROM window_start)
  GROUP BY ba.arm_id, ba.slot_id, ba.prompt_hash
  HAVING COUNT(bae.task_id) >= 2   -- skip arms with too few events
),
-- Mean eval quality_score per prompt_hash over the window
eval_scores AS (
  SELECT
    ec.prompt_hash,
    AVG(ec.quality_score)::DOUBLE PRECISION AS mean_eval_score,
    COUNT(*)                                AS eval_count
  FROM oweibo.eval_cache ec
  WHERE ec.prompt_hash IN (SELECT prompt_hash FROM arm_rewards)
  GROUP BY ec.prompt_hash
)
SELECT
  ar.arm_id,
  ar.prompt_hash,
  ar.mean_reward,
  es.mean_eval_score
FROM arm_rewards ar
JOIN eval_scores es ON es.prompt_hash = ar.prompt_hash
ORDER BY ar.arm_id
`;

// ── Flagging: sustained low-ρ check ─────────────────────────────────────────

async function checkAndFlag(pool: Pool, slotId: string, rho: number): Promise<boolean> {
  if (rho >= LOW_RHO_THRESH) return false;

  // Count consecutive low-ρ days (including today)
  const result = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
     FROM oweibo.eval_production_correlation
     WHERE slot_id = $1
       AND spearman_rho < $2
       AND computed_at >= NOW() - ($3 || ' days')::INTERVAL`,
    [slotId, LOW_RHO_THRESH, FLAG_DAYS],
  );

  const consecutiveDays = parseInt(result.rows[0]?.cnt ?? '0', 10);
  return consecutiveDays >= FLAG_DAYS;
}

// ── Core run ──────────────────────────────────────────────────────────────────

async function runCorrelator(): Promise<void> {
  const startMs     = Date.now();
  const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const windowEnd   = new Date().toISOString();

  console.log('[eval-correlator] Starting correlation run');

  // Get all slots that have active bandit arms
  const slotsResult = await pool.query<{ slot_id: string }>(
    `SELECT DISTINCT slot_id FROM oweibo.bandit_arms WHERE active = true`,
  );

  if (slotsResult.rows.length === 0) {
    console.log('[eval-correlator] No active slots — nothing to compute');
    return;
  }

  let computed = 0;
  let flagged  = 0;
  let errors   = 0;
  let tooFewData = 0;

  for (const { slot_id } of slotsResult.rows) {
    try {
      const scores = await pool.query<{
        arm_id:          string;
        prompt_hash:     string;
        mean_reward:     string;
        mean_eval_score: string;
      }>(SLOT_SCORES_SQL, [slot_id, WINDOW_DAYS]);

      if (scores.rows.length < 2) {
        // Not enough data points for a meaningful correlation
        tooFewData++;
        continue;
      }

      const rewards    = scores.rows.map(r => parseFloat(r.mean_reward));
      const evalScores = scores.rows.map(r => parseFloat(r.mean_eval_score));
      const rho        = spearman(rewards, evalScores);

      if (isNaN(rho)) {
        tooFewData++;
        continue;
      }

      const shouldFlag = await checkAndFlag(pool, slot_id, rho);

      await pool.query(
        `INSERT INTO oweibo.eval_production_correlation
           (slot_id, window_start, window_end, spearman_rho, sample_size, flagged)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (slot_id, computed_at) DO UPDATE SET
           spearman_rho = EXCLUDED.spearman_rho,
           sample_size  = EXCLUDED.sample_size,
           flagged      = EXCLUDED.flagged`,
        [slot_id, windowStart, windowEnd, rho, scores.rows.length, shouldFlag],
      );

      computed++;
      if (shouldFlag) {
        flagged++;
        console.warn(
          `[eval-correlator] ⚠  LOW RHO slot=${slot_id} ρ=${rho.toFixed(4)} ` +
          `sustained>=${FLAG_DAYS}d — charter paging triggered`,
        );
      } else {
        console.log(`[eval-correlator] slot=${slot_id} ρ=${rho.toFixed(4)} n=${scores.rows.length}`);
      }
    } catch (err) {
      errors++;
      console.error(`[eval-correlator] Error on slot=${slot_id}:`, String(err));
    }
  }

  const elapsedMs = Date.now() - startMs;
  console.log(
    `[eval-correlator] Done: computed=${computed} flagged=${flagged} ` +
    `too_few_data=${tooFewData} errors=${errors} elapsed=${elapsedMs}ms`,
  );
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await runCorrelator().catch(err => {
    console.error('[eval-correlator] Startup run failed:', String(err));
  });

  cron.schedule(CRON_EXPR, () => {
    runCorrelator().catch(err => {
      console.error('[eval-correlator] Scheduled run failed:', String(err));
    });
  });

  console.log(`[eval-correlator] Scheduled: "${CRON_EXPR}" (window=${WINDOW_DAYS}d, thresh=${LOW_RHO_THRESH})`);

  process.on('SIGTERM', async () => {
    console.log('[eval-correlator] SIGTERM — shutting down');
    await pool.end();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[eval-correlator] Fatal:', err);
  process.exit(1);
});
