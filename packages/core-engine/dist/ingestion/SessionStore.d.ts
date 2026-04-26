/**
 * SessionStore — cross-task session continuity (v5, §16b).
 *
 * Stores the history of tasks completed within a user session so the agent
 * can reference prior decisions, avoid repeating clarifications, and maintain
 * a coherent narrative across a multi-task workflow.
 *
 * Storage: Redis hash `session:{sessionId}` with a 7-day TTL (rolling).
 * Each append resets the TTL so active sessions never expire mid-flight.
 */
export interface SessionTaskSummary {
    readonly taskId: string;
    readonly goal: string;
    readonly outcome: 'success' | 'partial' | 'failed' | 'cancelled';
    readonly keyDecisions: readonly string[];
    readonly deliveredAt: string;
}
export interface SessionData {
    readonly sessionId: string;
    readonly userId: string;
    readonly tenantId: string;
    readonly createdAt: string;
    readonly tasks: SessionTaskSummary[];
    readonly clarifications: Record<string, string>;
}
export declare class SessionStore {
    private readonly redisGet;
    private readonly redisSetEx;
    constructor(redisGet: (key: string) => Promise<string | null>, redisSetEx: (key: string, ttl: number, value: string) => Promise<void>);
    private key;
    load(sessionId: string): Promise<SessionData | null>;
    save(data: SessionData): Promise<void>;
    appendTask(sessionId: string, userId: string, summary: SessionTaskSummary): Promise<void>;
    recordClarification(sessionId: string, question: string, answer: string): Promise<void>;
}
//# sourceMappingURL=SessionStore.d.ts.map