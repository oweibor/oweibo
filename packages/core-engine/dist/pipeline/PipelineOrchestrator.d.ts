import type { ArtifactBundle, PipelineTaskInput, PipelineTaskOutput, ISandbox, ILLMClient } from '@oweibo/core-contracts';
import type { ISemanticMemoryStore } from '@oweibo/core-contracts';
import type { PromptRegistry } from '../observability/PromptRegistry.js';
import type { TaskEventBus } from '../ingestion/TaskEventBus.js';
import type { LangfuseTraceClient } from 'langfuse';
import type { Redis } from 'ioredis';
export interface PipelineOrchestratorDeps {
    sandbox: ISandbox;
    llm: ILLMClient;
    memory: ISemanticMemoryStore;
    promptRegistry: PromptRegistry;
    eventBus: TaskEventBus;
    /** Redis client used by EntropyTracker for cross-worker rule-of-3 detection (G17). */
    redis?: Redis;
}
export declare class PipelineOrchestrator {
    private readonly deps;
    private readonly stages;
    constructor(deps: PipelineOrchestratorDeps);
    run(bundle: ArtifactBundle, input: PipelineTaskInput, trace: LangfuseTraceClient, sessionId: string): Promise<PipelineTaskOutput>;
}
//# sourceMappingURL=PipelineOrchestrator.d.ts.map