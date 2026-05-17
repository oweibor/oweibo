// §10.7 — GEPA velocity tracker: weekly cron computing per-slot frontier
// hypervolume gain and classifying velocity tiers for the cost-of-learning
// governor. The optimizer (apps/gepa-optimizer) reads oweibo.gepa_velocity_state
// at run start to decide offspring count, cadence, and whether to skip
// converged slots.
//
// Interaction with §17.5.1: the velocity governor operates at mode 5 (full
// operation) only. Modes ≤4 already pause or restrict GEPA activity.
//
// Usage:
//   node dist/index.js              — run on cron schedule (VELOCITY_CRON)
//   node dist/index.js --run-once   — single execution then exit

import { Pool } from 'pg';
import { computeHypervolumeGain } from './hypervolume.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type VelocityTier = 'healthy' | 'slowing' | 'stagnating' | 'converged';

export interface VelocityClassification {
  readonly slotId:        string;
  readonly tier:          VelocityTier;
  readonly delta7d:       number;
  readonly deltaBaseline: number;
  readonly ratio:         number;
}

// ── Configuration ─────────────────────────────────────────────────────────────

const DATABASE_URL    = process.env['DATABASE_URL'];
const VELOCITY_CRON   = process.env['VELOCITY_CRON'] ?? '0 3 * * 0';  // Sunday 03:00 UTC
const RUN_ONCE        = process.argv.includes('--run-once');

if (!DATABASE_URL) {
  console.error('[gepa-velocity-tracker] DATABASE_URL required');
  process.exit(1);
}

// ── Tier classification ───────────────────────────────────────────────────────

/**
 * Classify a slot's velocity ratio into a tier per §10.7 thresholds.
 *
 * | ratio             | tier        |
 * |--------------------|-------------|
 * | ≥ 1.0              | healthy     |
 * | 0.5 ≤ ratio < 1.0  | slowing     |
 * | 0.2 ≤ ratio < 0.5  | stagnating  |
 * | < 0.2              | converged   |
 */
export function classifyVelocityTier(ratio: number): VelocityTier {
  if (ratio >= 1.0) return 'healthy';
  if (ratio >= 0.5) return 'slowing';
  if (ratio >= 0.2) return 'stagnating';
  return 'converged';
}

// ── Active slot discovery ─────────────────────────────────────────────────────

interface SlotInfo {
  readonly role:   string;
  readonly slotId: string;
}

async function getActiveMutableSlots(pool: Pool): Promise<SlotInfo[]> {
  const result = await pool.query<{ role: string; slot_id: string }>(
    `SELECT DISTINCT role, slot_id
     FROM oweibo.prompt_versions
     WHERE mutation_status = 'mutable'
       OR mutation_status IS NULL
     ORDER BY role, slot_id`,
  );
  return result.rows.map(r => ({ role: r.role, slotId: r.slot_id }));
}

// ── Core computation ──────────────────────────────────────────────────────────

async function computeSlotVelocity(
  pool:   Pool,
  slotId: string,
): Promise<VelocityClassification> {
  const now = new Date();

  // 7-day window: [now - 7d, now]
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  // Baseline window: [now - 28d, now - 7d] (21-day span)
  const baselineStart = new Date(now);
  baselineStart.setDate(baselineStart.getDate() - 28);

  const delta7d       = await computeHypervolumeGain(pool, slotId, sevenDaysAgo, now);
  const deltaBaseline = await computeHypervolumeGain(pool, slotId, baselineStart, sevenDaysAgo);

  // Normalise baseline to a per-week rate (21 days → divide by 3 to get weekly)
  const baselineWeekly = deltaBaseline / 3;

  // Ratio: recent weekly gain vs. historical weekly average
  // Floor the denominator at 0.001 to avoid division by zero
  const ratio = delta7d / Math.max(baselineWeekly, 0.001);

  const tier = classifyVelocityTier(ratio);

  return {
    slotId,
    tier,
    delta7d,
    deltaBaseline,
    ratio,
  };
}

// ── Persistence ───────────────────────────────────────────────────────────────

async function upsertVelocityState(
  pool:   Pool,
  result: VelocityClassification,
): Promise<void> {
  await pool.query(
    `INSERT INTO oweibo.gepa_velocity_state
       (slot_id, velocity_tier, delta_7d, delta_baseline, computed_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (slot_id) DO UPDATE SET
       velocity_tier  = EXCLUDED.velocity_tier,
       delta_7d       = EXCLUDED.delta_7d,
       delta_baseline = EXCLUDED.delta_baseline,
       computed_at    = EXCLUDED.computed_at`,
    [result.slotId, result.tier, result.delta7d, result.deltaBaseline],
  );
}

// ── Operational mode check ────────────────────────────────────────────────────

async function checkOperationalMode(pool: Pool): Promise<boolean> {
  try {
    const result = await pool.query<{ current_mode: number }>(
      `SELECT current_mode FROM oweibo.platform_operational_mode WHERE singleton_id = TRUE`,
    );
    const mode = result.rows[0]?.current_mode ?? 5;
    if (mode < 5) {
      console.log(`[gepa-velocity-tracker] Skipping — platform mode ${mode} (velocity governor operates at mode 5 only)`);
      return false;
    }
    return true;
  } catch {
    // Fail-open: if mode table is unavailable, proceed
    console.warn('[gepa-velocity-tracker] Could not read operational mode — proceeding');
    return true;
  }
}

// ── Main run ──────────────────────────────────────────────────────────────────

async function run(pool: Pool): Promise<void> {
  console.log('[gepa-velocity-tracker] Starting velocity computation');
  const startMs = Date.now();

  // §17.5.1 — velocity governor is only relevant at mode 5
  const proceed = await checkOperationalMode(pool);
  if (!proceed) return;

  const slots = await getActiveMutableSlots(pool);
  if (slots.length === 0) {
    console.log('[gepa-velocity-tracker] No active mutable slots found — exiting');
    return;
  }

  console.log(`[gepa-velocity-tracker] Processing ${slots.length} mutable slot(s)`);

  const tierCounts: Record<VelocityTier, number> = {
    healthy: 0, slowing: 0, stagnating: 0, converged: 0,
  };

  for (const slot of slots) {
    try {
      const classification = await computeSlotVelocity(pool, slot.slotId);
      await upsertVelocityState(pool, classification);

      tierCounts[classification.tier]++;

      const tierEmoji: Record<VelocityTier, string> = {
        healthy: '🟢', slowing: '🟡', stagnating: '🟠', converged: '🔴',
      };
      console.log(
        `  ${tierEmoji[classification.tier]} ${slot.role}/${slot.slotId}: ` +
        `${classification.tier} (ratio=${classification.ratio.toFixed(3)}, ` +
        `Δ7d=${classification.delta7d}, Δbase=${classification.deltaBaseline})`,
      );
    } catch (err) {
      console.error(`[gepa-velocity-tracker] Error processing ${slot.role}/${slot.slotId}:`, err);
    }
  }

  const elapsedS = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(
    `[gepa-velocity-tracker] Done in ${elapsedS}s — ` +
    `healthy=${tierCounts.healthy} slowing=${tierCounts.slowing} ` +
    `stagnating=${tierCounts.stagnating} converged=${tierCounts.converged}`,
  );
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });

  if (RUN_ONCE) {
    try {
      await run(pool);
    } finally {
      await pool.end();
    }
    return;
  }

  // Cron mode — dynamic import to keep node-cron optional in test environments
  console.log(`[gepa-velocity-tracker] Scheduling on cron: ${VELOCITY_CRON}`);

  // Use setInterval-based scheduling to avoid requiring node-cron at runtime
  // For production, replace with node-cron or systemd timer
  const cronToMs = (): number => {
    // Default: weekly = 7 days in ms
    return 7 * 24 * 60 * 60 * 1000;
  };

  // Run immediately on start, then on schedule
  await run(pool);

  const interval = setInterval(async () => {
    try {
      await run(pool);
    } catch (err) {
      console.error('[gepa-velocity-tracker] Cron run failed:', err);
    }
  }, cronToMs());

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log('[gepa-velocity-tracker] Shutting down...');
    clearInterval(interval);
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT',  () => void shutdown());
}

main().catch(err => {
  console.error('[gepa-velocity-tracker] Fatal:', err);
  process.exit(1);
});

// ── Exports for testing ───────────────────────────────────────────────────────
export { classifyVelocityTier as _classifyVelocityTier };
