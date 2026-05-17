/**
 * SessionReaper — periodic job that recovers orphaned sessions (C4, v10.5).
 *
 * On each tick (default every 60 s):
 *   1. Scans doc-running:{tenantId} sorted sets for sessions with status:'running'.
 *   2. For each, checks whether doc-heartbeat:{sessionId} exists.
 *   3. If heartbeat absent: transitions session to status:'failed', reason:'worker-lost'.
 *   4. Emits doc-generation-warning WORKER_LOST on the event bus.
 */
import type { DocGeneratorQueue } from './DocGeneratorQueue.js';
import type { TaskEventBus } from '../../ingestion/TaskEventBus.js';
import type { ILogger } from '../analysis/validateGlobPatterns.js';
type RedisClient = {
    /** Non-blocking cursor scan (MED-4). cursor='0' starts a new scan; done when returned cursor='0'. */
    scan(cursor: string, matchOption: 'MATCH', pattern: string, countOption: 'COUNT', count: number): Promise<[string, string[]]>;
    zrange(key: string, start: number, stop: number): Promise<string[]>;
};
export declare class SessionReaper {
    private readonly queue;
    private readonly eventBus;
    private readonly redis;
    private readonly logger;
    private readonly intervalMs;
    private timer;
    constructor(queue: DocGeneratorQueue, eventBus: TaskEventBus, redis: RedisClient, logger: ILogger, intervalMs?: number);
    start(): void;
    stop(): void;
    tick(): Promise<void>;
}
export {};
//# sourceMappingURL=SessionReaper.d.ts.map