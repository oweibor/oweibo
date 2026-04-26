import type { Redis } from 'ioredis';
export declare class TaskHeartbeat {
    private readonly redis;
    private static readonly HEARTBEAT_KEY;
    private static readonly HEARTBEAT_TTL_SEC;
    private timers;
    constructor(redis: Redis);
    start(taskId: string, sessionId: string): Promise<void>;
    cancel(taskId: string): Promise<void>;
    private beat;
}
//# sourceMappingURL=TaskHeartbeat.d.ts.map