/**
 * LangfuseTracer — Langfuse AI observability integration (§16c).
 *
 * Provides traced LLM client wrappers, span emission for tool calls,
 * and task-level scoring. Falls back to a no-op implementation when
 * Langfuse is not configured (no LANGFUSE_SECRET_KEY in environment).
 */
import type { LangfuseTraceClient } from 'langfuse';
export declare function startAgentTrace(taskId: string, description: string, userId?: string): Promise<LangfuseTraceClient>;
export declare function scoreTask(trace: LangfuseTraceClient, scores: {
    testPassRate?: number;
    planFeasibility?: number;
    tokensEfficiency?: number;
    overallQuality?: number;
}): Promise<void>;
export declare function tracedToolCall<T>(trace: LangfuseTraceClient, toolName: string, input: unknown, fn: () => Promise<T>): Promise<T>;
export declare function tracedGeneration<T extends {
    promptTokens?: number;
    completionTokens?: number;
    output: string;
}>(trace: LangfuseTraceClient, name: string, model: string, systemPrompt: string, userPrompt: string, fn: () => Promise<T>): Promise<T>;
export declare function flushTraces(): Promise<void>;
//# sourceMappingURL=LangfuseTracer.d.ts.map