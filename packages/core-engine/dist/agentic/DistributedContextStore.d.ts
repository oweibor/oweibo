/**
 * DistributedContextStore — Redis-backed key-value store for cross-worker task state.
 *
 * Enables worker-restart resilience: if a worker crashes mid-task, the new worker
 * can load the last saved state and resume from the correct turn index rather than
 * starting over. Used by ConversationalLoop, GeneralCodingOrchestrator, and SwarmCoordinator.
 *
 * Keys are namespaced by purpose (e.g. `gc-session:{taskId}`, `gc-plan:{taskId}`).
 * Default TTL: 24 hours — sufficient for any single task's lifetime.
 */
export interface ContextRecord {
    readonly id: string;
    [key: string]: unknown;
}
export declare class DistributedContextStore {
    private readonly redisGet;
    private readonly redisSetEx;
    private readonly redisDel;
    constructor(redisGet: (key: string) => Promise<string | null>, redisSetEx: (key: string, ttl: number, value: string) => Promise<void>, redisDel: (key: string) => Promise<void>);
    save(record: ContextRecord): Promise<void>;
    load(id: string): Promise<ContextRecord | null>;
    delete(id: string): Promise<void>;
}
//# sourceMappingURL=DistributedContextStore.d.ts.map