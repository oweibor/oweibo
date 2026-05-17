/**
 * DocGeneratorWorker — long-polling worker that consumes DocGeneratorQueue (C1, C2, v10.5).
 *
 * Concurrency limits (C2):
 *   - maxConcurrentPerPod:    max parallel jobs on this process (default 3)
 *   - maxConcurrentPerTenant: max parallel jobs for one tenant across pods (default 2)
 *     Enforced via Redis sorted-set `doc-running:{tenantId}`.
 *
 * Heartbeat (C4): SETEX doc-heartbeat:{sessionId} 30 'alive' every 10 s.
 *
 * Token accounting (C14 / CRIT-1): adds ACTUAL spend (adapter.totalSpent) to quota
 * counter via redis.incrby after each run.
 *
 * Re-queue behaviour (CRIT-2): when per-tenant concurrency is full the original job
 * (with its sessionId intact) is re-enqueued with a 30 s back-off, up to MAX_TENANT_RETRIES
 * attempts before the session is marked failed.
 */
import type { DocGeneratorPipeline } from '../DocGeneratorPipeline.js';
import type { DocGeneratorQueue } from './DocGeneratorQueue.js';
import type { ILogger } from '../analysis/validateGlobPatterns.js';
type RedisClient = {
    zadd(key: string, score: number, member: string): Promise<number>;
    zrem(key: string, member: string): Promise<number>;
    zcard(key: string): Promise<number>;
    expire(key: string, ttl: number): Promise<number>;
};
export interface WorkerConfig {
    readonly maxConcurrentPerPod?: number;
    readonly maxConcurrentPerTenant?: number;
}
export declare class DocGeneratorWorker {
    private readonly pipeline;
    private readonly queue;
    private readonly redis;
    private readonly logger;
    private running;
    private stopped;
    private readonly maxPerPod;
    private readonly maxPerTenant;
    constructor(pipeline: DocGeneratorPipeline, queue: DocGeneratorQueue, redis: RedisClient, logger: ILogger, config?: WorkerConfig);
    /** Start the polling loop. Returns when stop() is called. */
    start(): Promise<void>;
    stop(): void;
    private processJob;
}
export {};
//# sourceMappingURL=DocGeneratorWorker.d.ts.map