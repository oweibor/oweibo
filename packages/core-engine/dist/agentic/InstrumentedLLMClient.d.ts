import type { ILLMClient, ILLMGenerateRequest, ILLMGenerateResponse } from '@oweibo/core-contracts';
import type { LangfuseTraceClient } from 'langfuse';
/**
 * InstrumentedLLMClient — wraps the base LLM HTTP client with Langfuse tracing.
 * Every generate() call produces a Langfuse generation span capturing:
 *   - model, prompt, completion, tokens, latency, taskId, role, slotId
 * Stateless — safe to instantiate once per agent per task.
 */
export declare class InstrumentedLLMClient implements ILLMClient {
    private readonly baseUrl;
    private readonly model;
    private readonly trace;
    private readonly taskId;
    private readonly role;
    private readonly slotId?;
    constructor(baseUrl: string, model: string, trace: LangfuseTraceClient, taskId?: string, role?: string, slotId?: string | undefined);
    private static readonly samplingRate;
    generate(params: ILLMGenerateRequest): Promise<ILLMGenerateResponse>;
    stream(params: {
        systemPrompt: string;
        userPrompt: string;
    }): AsyncIterable<string>;
    private callApi;
}
//# sourceMappingURL=InstrumentedLLMClient.d.ts.map