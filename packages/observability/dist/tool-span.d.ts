import type { TaskContext } from './agent-span.js';
export interface ToolSpanOptions {
    toolName: string;
    toolType: 'function' | 'retrieval' | 'code-execution';
    callId?: string;
}
/**
 * Wraps a ToolRegistry.invoke() call in an execute_tool OTel span.
 * A unique callId is generated if not provided.
 */
export declare function withToolSpan<T>(opts: ToolSpanOptions, taskCtx: TaskContext, fn: () => Promise<T>): Promise<T>;
//# sourceMappingURL=tool-span.d.ts.map