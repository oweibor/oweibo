"use strict";
// E.1 — ModelBanditService: per-task-category bandit-driven model tier selection.
// Tracked separately from prompt bandits (§E.2).
// Same Thompson sampling mechanics as BanditService; separate DB tables.
//
// Tier ladder: small → mid → large.
// The bandit selects which tier to use for a given task category.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModelBanditService = void 0;
// ── Thompson sampling (LCG-seeded, same algorithm as BanditService) ───────────
function seededRng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xFFFFFFFF; };
}
function normalSample(rng) {
    return Math.sqrt(-2 * Math.log(rng())) * Math.cos(2 * Math.PI * rng());
}
function gammaSample(shape, rng) {
    if (shape < 1)
        return gammaSample(1 + shape, rng) * rng() ** (1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
        let x, v;
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
function betaSample(alpha, beta, rng) {
    const x = gammaSample(alpha, rng);
    const y = gammaSample(beta, rng);
    return x / (x + y);
}
// Default tiers when DB has no arms configured (cold-start behaviour)
const DEFAULT_TIER_MAP = {
    file_read: 'small',
    symbol_lookup: 'small',
    governance: 'small',
    summarisation: 'small',
    diff_gen: 'mid',
    coding: 'mid',
    debugging: 'mid',
    documentation: 'mid',
    refactoring: 'large',
    planning: 'large',
    analysis: 'large',
};
// ── ModelBanditService ────────────────────────────────────────────────────────
class ModelBanditService {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    /**
     * Draw a model tier for the given task category using Thompson sampling.
     * Falls back to DEFAULT_TIER_MAP on DB failure or empty arm table.
     * 5% forced exploration; deterministic on (taskId, category) seed.
     */
    async draw(taskId, category) {
        try {
            const arms = await this.loadArms(category);
            if (arms.length === 0) {
                return { tier: DEFAULT_TIER_MAP[category] ?? 'mid', modelId: 'default' };
            }
            if (arms.length === 1) {
                return { tier: arms[0].tier, modelId: arms[0].modelId };
            }
            const seed = [...`${taskId}:${category}`].reduce((acc, c) => (Math.imul(acc, 31) + c.charCodeAt(0)) | 0, 5381) >>> 0;
            const rng = seededRng(seed);
            // 5% forced exploration
            if (rng() < 0.05) {
                const arm = arms[Math.floor(rng() * arms.length)];
                return { tier: arm.tier, modelId: arm.modelId };
            }
            // Thompson: pick arm with highest sampled Beta value
            let best = arms[0];
            let bestSample = betaSample(best.alpha, best.beta, rng);
            for (const arm of arms.slice(1)) {
                const s = betaSample(arm.alpha, arm.beta, rng);
                if (s > bestSample) {
                    bestSample = s;
                    best = arm;
                }
            }
            return { tier: best.tier, modelId: best.modelId };
        }
        catch {
            // Never block task path — fall back to static map
            return { tier: DEFAULT_TIER_MAP[category] ?? 'mid', modelId: 'default' };
        }
    }
    /**
     * E.2: Record task outcome for a model tier selection.
     * Idempotent via model_bandit_events PK.
     */
    async recordReward(params) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const existing = await client.query(`SELECT 1 FROM oweibo.model_bandit_events
         WHERE task_id = $1 AND category = $2 AND model_id = $3`, [params.taskId, params.category, params.modelId]);
            if ((existing.rowCount ?? 0) > 0) {
                await client.query('ROLLBACK');
                return;
            }
            await client.query(`INSERT INTO oweibo.model_bandit_events (task_id, category, tier, model_id, reward)
         VALUES ($1,$2,$3,$4,$5)`, [params.taskId, params.category, params.tier, params.modelId, params.reward]);
            if (params.reward >= 0.5) {
                await client.query(`UPDATE oweibo.model_bandit_arms
           SET alpha = alpha + $1, updated_at = NOW()
           WHERE category = $2 AND model_id = $3`, [params.reward, params.category, params.modelId]);
            }
            else {
                await client.query(`UPDATE oweibo.model_bandit_arms
           SET beta = beta + $1, updated_at = NOW()
           WHERE category = $2 AND model_id = $3`, [1 - params.reward, params.category, params.modelId]);
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
    async loadArms(category) {
        const result = await this.pool.query(`SELECT tier, model_id AS "modelId", alpha, beta
       FROM oweibo.model_bandit_arms
       WHERE category = $1 AND active = true
       ORDER BY tier, model_id`, [category]);
        return result.rows;
    }
}
exports.ModelBanditService = ModelBanditService;
//# sourceMappingURL=ModelBanditService.js.map