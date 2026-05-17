/**
 * DocGeneratorQueue — Redis-backed job queue for doc-gen runs (C1, v10.5).
 *
 * Uses RPUSH/BLPOP (consistent with existing TaskQueue pattern) instead of BullMQ
 * so that no additional dependency is required. Queue name: `doc-generator`.
 *
 * Idempotency (C3): stores idempotencyKey → sessionId in Redis with 24 h TTL.
 * Daily quota (C14): INCR doc-tokens:{tenantId}:{YYYY-MM-DD} against a per-tenant cap.
 */
import type { DocGenJob } from '../DocGeneratorPipeline.js';
type RedisClient = {
    rpush(key: string, ...values: string[]): Promise<number>;
    blpop(keys: string[], timeout: number): Promise<[string, string] | null>;
    llen(key: string): Promise<number>;
    lrange(key: string, start: number, stop: number): Promise<string[]>;
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
    setex(key: string, ttl: number, value: string): Promise<unknown>;
    setnx(key: string, value: string): Promise<number>;
    incr(key: string): Promise<number>;
    incrby(key: string, increment: number): Promise<number>;
    expire(key: string, ttl: number): Promise<number>;
    del(key: string): Promise<number>;
};
export interface EnqueueResult {
    readonly sessionId: string;
    readonly queued: boolean;
    readonly existing: boolean;
    /** Present when existing=true — the current session state for the client to inspect (LOW-4). */
    readonly sessionState?: Record<string, unknown>;
}
export declare class DocGeneratorQueue {
    private readonly redis;
    private readonly config;
    constructor(redis: RedisClient, config?: {
        dailyTokenQuota?: number;
    });
    enqueue(job: Omit<DocGenJob, 'sessionId'> & {
        sessionId?: string;
    }): Promise<EnqueueResult>;
    dequeue(timeoutSec?: number): Promise<DocGenJob | null>;
    cancel(tenantId: string, sessionId: string): Promise<void>;
    updateStatus(tenantId: string, sessionId: string, update: Record<string, unknown>): Promise<void>;
    getStatus(tenantId: string, sessionId: string): Promise<Record<string, unknown> | null>;
    heartbeat(sessionId: string): Promise<void>;
    isAlive(sessionId: string): Promise<boolean>;
    checkDailyQuota(tenantId: string): Promise<{
        ok: boolean;
        spent: number;
        limit: number;
    }>;
    addTokenSpend(tenantId: string, tokens: number): Promise<void>;
    /**
     * Returns the 0-based position of sessionId in the queue, or null if not queued.
     * Position 0 = next job to be dequeued (front of list). (MED-3)
     */
    getPosition(sessionId: string): Promise<number | null>;
}
export {};
//# sourceMappingURL=DocGeneratorQueue.d.ts.map