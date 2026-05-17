import type { TaskContext } from './agent-span.js';
export interface LLMSpanOptions {
    system: string;
    model: string;
    operation: 'chat' | 'embeddings';
    temperature?: number;
    maxTokens?: number;
    topP?: number;
}
export interface LLMSpanResult {
    inputTokens?: number;
    outputTokens?: number;
    responseModel?: string;
    responseId?: string;
    finishReasons?: string[];
}
/**
 * Wraps a chat or embeddings call in a gen_ai OTel span.
 * Optionally accepts a getResult() extractor to record token counts
 * and other response metadata after the call completes.
 */
export declare function withLLMSpan<T>(opts: LLMSpanOptions, taskCtx: TaskContext, fn: () => Promise<T>, getResult?: (r: T) => LLMSpanResult): Promise<T>;
//# sourceMappingURL=llm-span.d.ts.map