/**
 * T.3.a: platform-priors-aggregator entry point.
 *
 * Daily cron at 03:00 UTC by default. Calls PriorsAggregator.runOnce()
 * which:
 *   1. Aggregates platform-wide bandit priors from per-tenant arms.
 *   2. Enforces K-anonymity (>= 5 distinct contributing tenants).
 *   3. Caps prior strength to avoid dominating cold-start observations.
 *   4. UPSERTs eligible rows; deletes rows that fell below K since the
 *      previous run.
 *
 * Env:
 *   DATABASE_URL — required
 *   PRIORS_CRON_EXPR — cron expression (default '0 3 * * *')
 *   PRIORS_K_ANONYMITY — override K (default 5)
 *   PRIORS_STRENGTH_CAP — override strength cap (default 50)
 *   PRIORS_WINDOW_DAYS — rolling window in days (default 90)
 *   BANDIT_USE_PLATFORM_PRIORS — when set to 'false', the aggregator
 *     still runs but produces no rows (canary safety valve).
 */
import { Pool } from 'pg';
import cron from 'node-cron';
import { PriorsAggregator } from './PriorsAggregator.js';

async function main(): Promise<void> {
  const DATABASE_URL = process.env['DATABASE_URL'];
  if (!DATABASE_URL) {
    console.error('[platform-priors-aggregator] DATABASE_URL required');
    process.exit(1);
  }
  const CRON_EXPR = process.env['PRIORS_CRON_EXPR'] ?? '0 3 * * *';
  const K = parseInt(process.env['PRIORS_K_ANONYMITY'] ?? '5', 10);
  const CAP = parseInt(process.env['PRIORS_STRENGTH_CAP'] ?? '50', 10);
  const WINDOW_DAYS = parseInt(process.env['PRIORS_WINDOW_DAYS'] ?? '90', 10);
  const enabled = process.env['BANDIT_USE_PLATFORM_PRIORS'] !== 'false';

  const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
  const aggregator = new PriorsAggregator(pool, {
    kAnonymity: K,
    priorStrengthCap: CAP,
    windowDays: WINDOW_DAYS,
    isAllowed: async () => enabled,
  });

  // Run once on startup so a deploy doesn't require waiting until the next
  // cron tick to see the first set of priors.
  void aggregator.runOnce().catch((err) =>
    console.error('[platform-priors-aggregator] initial run failed', err),
  );

  cron.schedule(CRON_EXPR, () => {
    void aggregator.runOnce().catch((err) =>
      console.error('[platform-priors-aggregator] scheduled run failed', err),
    );
  });

  console.log(`[platform-priors-aggregator] scheduled '${CRON_EXPR}' (K=${K}, cap=${CAP}, window=${WINDOW_DAYS}d)`);

  const shutdown = async (): Promise<void> => {
    console.log('[platform-priors-aggregator] shutting down');
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

void main().catch((err) => {
  console.error('[platform-priors-aggregator] fatal', err);
  process.exit(1);
});
