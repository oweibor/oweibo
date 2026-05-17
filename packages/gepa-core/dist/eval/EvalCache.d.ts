import type { Pool } from 'pg';
import type { EvalScore } from './EvalRunner.js';
export interface EvalCacheEntry {
    readonly promptHash: string;
    readonly taskId: string;
    readonly evalSuiteVersion: string;
    readonly qualityPass: boolean;
    readonly qualityScore: number;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly latencyMs: number;
    readonly outputHash: string;
    readonly cachedAt: Date;
}
export declare class EvalCache {
    private readonly pool;
    constructor(pool: Pool);
    get(promptHash: string, taskId: string, evalSuiteVersion: string): Promise<EvalCacheEntry | null>;
    set(score: EvalScore): Promise<void>;
    /**
     * C.1a: Verify determinism — compare stored output hash with a fresh run's hash.
     * Returns true if they match (deterministic), false if they diverge.
     */
    verifyDeterminism(promptHash: string, taskId: string, evalSuiteVersion: string, freshOutputHash: string): Promise<boolean>;
    /** Return hit rate over the last N hours. */
    hitRate(windowHours?: number): Promise<number>;
}
//# sourceMappingURL=EvalCache.d.ts.map