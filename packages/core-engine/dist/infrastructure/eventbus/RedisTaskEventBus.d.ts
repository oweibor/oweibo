/**
 * RedisTaskEventBus — Redis pub/sub-backed TaskEventBus for multi-pod SSE (B3, v10.4).
 *
 * Uses separate pub/sub clients per Redis best practice. Events are namespaced
 * doc-events:{tenantId} and filtered by sessionId on the subscriber side.
 *
 * When mode=redis, this replaces the in-memory TaskEventBus for all doc-generator
 * session events. Wired in main.ts behind docs.generator.eventBus.mode flag.
 */
import type { TaskEvent, TaskEventHandler } from '../../ingestion/TaskEventBus.js';
import type { ILogger } from '../../doc-generator/analysis/validateGlobPatterns.js';
type RedisClient = {
    publish(channel: string, message: string): Promise<number>;
    subscribe(channel: string): Promise<unknown>;
    unsubscribe(channel: string): Promise<unknown>;
    on(event: 'message', handler: (channel: string, message: string) => void): void;
    off(event: 'message', handler: (channel: string, message: string) => void): void;
};
export declare class RedisTaskEventBus {
    private readonly pub;
    private readonly sub;
    private readonly logger;
    private readonly channelListeners;
    constructor(pub: RedisClient, sub: RedisClient, logger: ILogger);
    publish(sessionId: string, event: Omit<TaskEvent, 'timestamp'>): Promise<void>;
    subscribe(tenantId: string, sessionId: string, handler: TaskEventHandler): () => void;
}
export {};
//# sourceMappingURL=RedisTaskEventBus.d.ts.map