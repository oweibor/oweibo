// DONE: Phase C.2 — EvalCache (Postgres-backed).
// Keyed by (promptHash, taskId, evalSuiteVersion).
// Hit rate target: ≥75% by week 2.
// C.1a: Stores output hash for determinism verification.
export class EvalCache {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async get(promptHash, taskId, evalSuiteVersion) {
        const result = await this.pool.query(`SELECT * FROM oweibo.eval_cache
       WHERE prompt_hash = $1 AND task_id = $2 AND eval_suite_version = $3
       LIMIT 1`, [promptHash, taskId, evalSuiteVersion]);
        return result.rows[0] ?? null;
    }
    async set(score) {
        await this.pool.query(`INSERT INTO oweibo.eval_cache
         (prompt_hash, task_id, eval_suite_version, quality_pass, quality_score,
          prompt_tokens, completion_tokens, latency_ms, output_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (prompt_hash, task_id, eval_suite_version) DO UPDATE SET
         quality_pass      = EXCLUDED.quality_pass,
         quality_score     = EXCLUDED.quality_score,
         prompt_tokens     = EXCLUDED.prompt_tokens,
         completion_tokens = EXCLUDED.completion_tokens,
         latency_ms        = EXCLUDED.latency_ms,
         output_hash       = EXCLUDED.output_hash,
         cached_at         = NOW()`, [
            score.promptHash, score.taskId, score.evalSuiteVersion,
            score.qualityPass, score.qualityScore,
            score.promptTokens, score.completionTokens, score.latencyMs,
            score.outputHash,
        ]);
    }
    /**
     * C.1a: Verify determinism — compare stored output hash with a fresh run's hash.
     * Returns true if they match (deterministic), false if they diverge.
     */
    async verifyDeterminism(promptHash, taskId, evalSuiteVersion, freshOutputHash) {
        const cached = await this.get(promptHash, taskId, evalSuiteVersion);
        if (!cached)
            return true; // no baseline — treat as deterministic
        return cached.outputHash === freshOutputHash;
    }
    /** Return hit rate over the last N hours. */
    async hitRate(windowHours = 24) {
        const result = await this.pool.query(`SELECT
         COALESCE(
           SUM(CASE WHEN cached_at > NOW() - INTERVAL '1 hour' * $1 THEN 1 ELSE 0 END)::NUMERIC /
           NULLIF(COUNT(*), 0),
           0
         ) AS hit_rate
       FROM oweibo.eval_cache`, [windowHours]);
        return parseFloat(result.rows[0]?.hit_rate ?? '0');
    }
}
//# sourceMappingURL=EvalCache.js.map