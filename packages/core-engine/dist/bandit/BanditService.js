"use strict";
// DONE: Phase D.2 — BanditService: per-slot Thompson sampling.
// Closes audit gaps E-03 + G-03 (bandit_arm_events dedup table),
//                  E-04 (optimistic lock on oweibo.channels version column).
// Reward signal: task.feedback thumbs events from Redis.
Object.defineProperty(exports, "__esModule", { value: true });
exports.BanditService = void 0;
// ── Thompson sampling ─────────────────────────────────────────────────────────
/** Sample from Beta(alpha, beta) using the Johnk method (pure deterministic with rng). */
function betaSample(alpha, beta, rng = Math.random) {
    // Approximation via normal for large params; exact for small
    if (alpha < 1 && beta < 1) {
        // Johnk's method
        while (true) {
            const u = rng() ** (1 / alpha);
            const v = rng() ** (1 / beta);
            if (u + v <= 1)
                return u / (u + v);
        }
    }
    // Gamma-ratio method (approximate)
    const x = gammaSample(alpha, rng);
    const y = gammaSample(beta, rng);
    return x / (x + y);
}
function gammaSample(shape, rng = Math.random) {
    if (shape < 1)
        return gammaSample(1 + shape, rng) * rng() ** (1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
        let x;
        let v;
        do {
            x = normalSample(rng);
            v = 1 + c * x;
        } while (v <= 0);
        v = v ** 3;
        const u = rng();
        if (u < 1 - 0.0331 * (x ** 2) ** 2)
            return d * v;
        if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v)))
            return d * v;
    }
}
function normalSample(rng = Math.random) {
    // Box-Muller
    const u1 = rng(), u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
// ── BanditService ─────────────────────────────────────────────────────────────
class BanditService {
    pool;
    operationalMode;
    constructor(pool, 
    /** Optional: enforces §17.5.1 mode checks on reward recording and promotion. */
    operationalMode) {
        this.pool = pool;
        this.operationalMode = operationalMode;
    }
    /**
     * Draw an arm for a given (slotId, channel) using Thompson sampling.
     * 5% of draws are forced exploration (random arm selection).
     *
     * @param rngSeed Deterministic seed — used for resumed tasks (rng is seeded by taskId+slotId).
     */
    async draw(params) {
        const arms = await this.loadArms(params.slotId, params.channel);
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
            const arm = arms[idx];
            return { armId: arm.id, promptHash: arm.promptHash, channel: arm.channel };
        }
        // Thompson: sample from Beta(alpha, beta) for each arm, pick highest
        let bestArm = arms[0];
        let bestSample = betaSample(bestArm.alpha, bestArm.beta, rng);
        for (const arm of arms.slice(1)) {
            const sample = betaSample(arm.alpha, arm.beta, rng);
            if (sample > bestSample) {
                bestSample = sample;
                bestArm = arm;
            }
        }
        return { armId: bestArm.id, promptHash: bestArm.promptHash, channel: bestArm.channel };
    }
    /**
     * Record a reward and update arm parameters.
     * Idempotent: uses bandit_arm_events dedup table (closes E-03).
     * §17.5.1 Mode ≤ 3: bandit learning is paused — returns silently without recording.
     */
    async recordReward(reward) {
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
            const existing = await client.query(`SELECT 1 FROM oweibo.bandit_arm_events
         WHERE task_id = $1 AND slot_id = $2 AND arm_id = $3`, [reward.taskId, reward.slotId, reward.armId]);
            if ((existing.rowCount ?? 0) > 0) {
                await client.query('ROLLBACK');
                return; // already recorded
            }
            // Insert event
            await client.query(`INSERT INTO oweibo.bandit_arm_events (task_id, slot_id, arm_id, reward, recorded_at)
         VALUES ($1,$2,$3,$4,NOW())`, [reward.taskId, reward.slotId, reward.armId, reward.reward]);
            // Update arm parameters (Beta conjugate update)
            if (reward.reward >= 0.5) {
                await client.query(`UPDATE oweibo.bandit_arms SET alpha = alpha + $1, updated_at = NOW()
           WHERE slot_id = $2 AND arm_id = $3`, [reward.reward, reward.slotId, reward.armId]);
            }
            else {
                await client.query(`UPDATE oweibo.bandit_arms SET beta = beta + $1, updated_at = NOW()
           WHERE slot_id = $2 AND arm_id = $3`, [1 - reward.reward, reward.slotId, reward.armId]);
            }
            await client.query('COMMIT');
        }
        catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
        finally {
            client.release();
        }
    }
    async loadArms(slotId, channel) {
        const result = await this.pool.query(`SELECT arm_id AS id, prompt_hash, slot_id, channel, alpha, beta
       FROM oweibo.bandit_arms
       WHERE slot_id = $1 AND channel = $2 AND active = true
       ORDER BY arm_id`, [slotId, channel]);
        return result.rows;
    }
    /**
     * Update channel pointer atomically with optimistic lock (closes E-04).
     * Fails if version has been updated concurrently.
     * §17.5.1 Mode ≤ 1: promotions are frozen — throws OperationDisabledError.
     */
    async promoteArm(params) {
        // Mode check: promotions disabled at mode ≤ 1 (throws — promotion is an explicit action)
        if (this.operationalMode) {
            await this.operationalMode.assertAllowed('promotions');
        }
        const result = await this.pool.query(`UPDATE oweibo.channels
       SET prompt_hash = $1, version = version + 1, updated_at = NOW(), updated_by = $2
       WHERE name = $3 AND role = $4 AND slot_id = $5 AND version = $6`, [params.promptHash, params.updatedBy, params.channel, params.role, params.slotId, params.currentVersion]);
        return (result.rowCount ?? 0) > 0;
    }
}
exports.BanditService = BanditService;
// ── Seeded RNG (LCG) ──────────────────────────────────────────────────────────
function seededRng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0xFFFFFFFF;
    };
}
//# sourceMappingURL=BanditService.js.map