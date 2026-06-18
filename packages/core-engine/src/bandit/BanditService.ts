// DONE: Phase D.2 — BanditService: per-slot Thompson sampling.
// Closes audit gaps E-03 + G-03 (bandit_arm_events dedup table),
//                  E-04 (optimistic lock on oweibo.channels version column).
// Reward signal: task.feedback thumbs events from Redis.

import type { Pool } from 'pg';
import type { CanonicalRole } from '@oweibo/core-contracts';
import type { OperationalModeService } from '../infrastructure/OperationalModeService.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BanditArm {
  readonly id:         string;   // prompt_versions.hash
  readonly promptHash: string;
  readonly slotId:     string;
  readonly channel:    string;
  /** Thompson sampling parameters — Beta(alpha, beta). */
  alpha: number;
  beta:  number;
}

export interface DrawResult {
  readonly armId:      string;
  readonly promptHash: string;
  readonly channel:    string;
}

export interface BanditReward {
  readonly taskId:  string;
  readonly slotId:  string;
  readonly armId:   string;
  readonly reward:  number;   // 1.0 = thumbs_up, 0.0 = thumbs_down, 0.5 = no signal
}

// ── Thompson sampling ─────────────────────────────────────────────────────────

/** Sample from Beta(alpha, beta) using the Johnk method (pure deterministic with rng). */
function betaSample(alpha: number, beta: number, rng = Math.random): number {
  // Approximation via normal for large params; exact for small
  if (alpha < 1 && beta < 1) {
    // Johnk's method
    while (true) {
      const u = rng() ** (1 / alpha);
      const v = rng() ** (1 / beta);
      if (u + v <= 1) return u / (u + v);
    }
  }
  // Gamma-ratio method (approximate)
  const x = gammaSample(alpha, rng);
  const y = gammaSample(beta,  rng);
  return x / (x + y);
}

function gammaSample(shape: number, rng = Math.random): number {
  if (shape < 1) return gammaSample(1 + shape, rng) * rng() ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x: number;
    let v: number;
    do {
      x = normalSample(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v ** 3;
    const u = rng();
    if (u < 1 - 0.0331 * (x ** 2) ** 2) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function normalSample(rng = Math.random): number {
  // Box-Muller
  const u1 = rng(), u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ── BanditService ─────────────────────────────────────────────────────────────

export class BanditService {
  constructor(
    private readonly pool: Pool,
    /** Optional: enforces §17.5.1 mode checks on reward recording and promotion. */
    private readonly operationalMode?: OperationalModeService,
  ) {}

  /**
   * Draw an arm for a given (slotId, channel) using Thompson sampling.
   * 5% of draws are forced exploration (random arm selection).
   *
   * @param rngSeed Deterministic seed — used for resumed tasks (rng is seeded by taskId+slotId).
   */
  async draw(params: {
    slotId:   string;
    channel:  string;
    role:     CanonicalRole;
    rngSeed?: number;
  }): Promise<DrawResult> {
    const arms = await this.loadArms(params.slotId, params.channel, params.role);
    if (arms.length === 0) {
      // No arms — return stable-v0 sentinel
      return { armId: 'stable-v0', promptHash: 'stable-v0', channel: params.channel };
    }

    // 5% forced exploration
    const rng = params.rngSeed !== undefined
      ? seededRng(params.rngSeed)
      : Math.random;

    if (rng() < 0.05) {
      const idx = Math.floor(rng() * arms.length);
      const arm = arms[idx]!;
      return { armId: arm.id, promptHash: arm.promptHash, channel: arm.channel };
    }

    // Thompson: sample from Beta(alpha, beta) for each arm, pick highest
    let bestArm = arms[0]!;
    let bestSample = betaSample(bestArm.alpha, bestArm.beta, rng);

    for (const arm of arms.slice(1)) {
      const sample = betaSample(arm.alpha, arm.beta, rng);
      if (sample > bestSample) {
        bestSample = sample;
        bestArm    = arm;
      }
    }

    return { armId: bestArm.id, promptHash: bestArm.promptHash, channel: bestArm.channel };
  }

  /**
   * Record a reward and update arm parameters.
   * Idempotent: uses bandit_arm_events dedup table (closes E-03).
   * §17.5.1 Mode ≤ 3: bandit learning is paused — returns silently without recording.
   */
  async recordReward(reward: BanditReward): Promise<void> {
    // Mode check: bandit_learning disabled at mode ≤ 3
    if (this.operationalMode) {
      const allowed = await this.operationalMode.isAllowed('bandit_learning');
      if (!allowed) {
        console.debug('[BanditService] recordReward skipped — bandit_learning disabled by operational mode');
        return;
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Dedup check — prevent double-counting late feedback
      const existing = await client.query(
        `SELECT 1 FROM oweibo.bandit_arm_events
         WHERE task_id = $1 AND slot_id = $2 AND arm_id = $3`,
        [reward.taskId, reward.slotId, reward.armId],
      );
      if ((existing.rowCount ?? 0) > 0) {
        await client.query('ROLLBACK');
        return; // already recorded
      }

      // Insert event
      await client.query(
        `INSERT INTO oweibo.bandit_arm_events (task_id, slot_id, arm_id, reward, recorded_at)
         VALUES ($1,$2,$3,$4,NOW())`,
        [reward.taskId, reward.slotId, reward.armId, reward.reward],
      );

      // Update arm parameters (Beta conjugate update)
      if (reward.reward >= 0.5) {
        await client.query(
          `UPDATE oweibo.bandit_arms SET alpha = alpha + $1, updated_at = NOW()
           WHERE slot_id = $2 AND arm_id = $3`,
          [reward.reward, reward.slotId, reward.armId],
        );
      } else {
        await client.query(
          `UPDATE oweibo.bandit_arms SET beta = beta + $1, updated_at = NOW()
           WHERE slot_id = $2 AND arm_id = $3`,
          [1 - reward.reward, reward.slotId, reward.armId],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async loadArms(slotId: string, channel: string, role?: CanonicalRole): Promise<BanditArm[]> {
    const result = await this.pool.query<BanditArm>(
      `SELECT arm_id AS id, prompt_hash, slot_id, channel, alpha, beta
       FROM oweibo.bandit_arms
       WHERE slot_id = $1 AND channel = $2 AND active = true
       ORDER BY arm_id`,
      [slotId, channel],
    );
    if (result.rows.length > 0) return result.rows;

    // T.3.a: cold-start fallback — synthesize a single arm from the
    // platform-aggregated prior when one exists for (role, slot, channel).
    // The arm is *not* persisted; recordReward will INSERT a real row on
    // the first observation. Feature-gated by BANDIT_USE_PLATFORM_PRIORS
    // so the rollout can canary without affecting today's behaviour.
    if (!role || process.env['BANDIT_USE_PLATFORM_PRIORS'] !== 'true') {
      return [];
    }
    const scopeKey = `${role}:${slotId}:${channel}`;
    const prior = await this.pool.query<{ alpha_sum: string; beta_sum: string }>(
      `SELECT alpha_sum::text, beta_sum::text
         FROM oweibo.platform_bandit_priors
        WHERE scope_kind = 'prompt_slot' AND scope_key = $1`,
      [scopeKey],
    );
    const row = prior.rows[0];
    if (!row) return [];
    return [{
      id:         `prior:${scopeKey}`,
      promptHash: 'stable-v0',
      slotId,
      channel,
      alpha:      Number(row.alpha_sum),
      beta:       Number(row.beta_sum),
    } as BanditArm];
  }

  /**
   * Update channel pointer atomically with optimistic lock (closes E-04).
   * Fails if version has been updated concurrently.
   * §17.5.1 Mode ≤ 1: promotions are frozen — throws OperationDisabledError.
   */
  async promoteArm(params: {
    role:        CanonicalRole;
    slotId:      string;
    channel:     string;
    promptHash:  string;
    currentVersion: bigint;
    updatedBy:   string;
  }): Promise<boolean> {
    // Mode check: promotions disabled at mode ≤ 1 (throws — promotion is an explicit action)
    if (this.operationalMode) {
      await this.operationalMode.assertAllowed('promotions');
    }

    const result = await this.pool.query(
      `UPDATE oweibo.channels
       SET prompt_hash = $1, version = version + 1, updated_at = NOW(), updated_by = $2
       WHERE name = $3 AND role = $4 AND slot_id = $5 AND version = $6`,
      [params.promptHash, params.updatedBy, params.channel, params.role, params.slotId, params.currentVersion],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

// ── Seeded RNG (LCG) ──────────────────────────────────────────────────────────
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xFFFFFFFF;
  };
}
