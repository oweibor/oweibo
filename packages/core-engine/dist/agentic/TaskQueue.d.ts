/**
 * TaskQueue — async task queue backed by Redis (v5, §16a).
 *
 * Tasks submitted via IntentPipeline are enqueued here and picked up by
 * background workers that call CognitiveEngine.processTask().
 *
 * Uses a Redis list (`LPUSH` / `BRPOP`) for simple, durable FIFO delivery.
 * Per-tenant queues (`task-queue:{tenantId}`) allow rate-limiting per tenant.
 */
import type { IAgentTask } from '@oweibo/core-contracts';
export type TaskHandler = (task: IAgentTask) => Promise<void>;
export declare class TaskQueue {
    private readonly redisPush;
    private readonly redisBPop;
    private readonly redisPeek;
    private readonly tenantIds;
    private handlers;
    private running;
    constructor(redisPush: (key: string, value: string) => Promise<void>, redisBPop: (keys: string[], timeoutSeconds: number) => Promise<[string, string] | null>, redisPeek: (key: string) => Promise<string | null>, tenantIds: () => string[]);
    private queueKey;
    /** Enqueue a task for processing. */
    enqueue(task: IAgentTask): Promise<void>;
    /** Register a handler to process dequeued tasks. */
    onTask(handler: TaskHandler): void;
    /**
     * startWorker — begins processing tasks from all tenant queues.
     * Runs until stop() is called. Should be called once in main.ts.
     */
    startWorker(): Promise<void>;
    stop(): void;
}
//# sourceMappingURL=TaskQueue.d.ts.map