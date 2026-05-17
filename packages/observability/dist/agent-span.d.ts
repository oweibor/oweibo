export interface TaskContext {
    tenantId: string;
    userId: string;
    taskId: string;
    runId?: string;
    trust?: string;
    principal?: 'user' | 'api_key' | 'agent';
}
/**
 * Wraps a pipeline stage function in an invoke_agent OTel span.
 * All required GenAI + oweibo.* attributes are set automatically.
 * Uses no-op spans when no SDK is initialized (safe in tests).
 */
export declare function withAgentSpan<T>(agentId: string, taskCtx: TaskContext, fn: () => Promise<T>): Promise<T>;
//# sourceMappingURL=agent-span.d.ts.map