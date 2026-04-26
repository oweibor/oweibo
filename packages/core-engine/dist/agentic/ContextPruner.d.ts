import type { LangfuseTraceClient } from 'langfuse';
import type { DistributedContextStore } from './DistributedContextStore.js';
export declare class ContextPruner {
    private readonly contextStore;
    private static readonly MAX_MESSAGES;
    constructor(contextStore: DistributedContextStore);
    pruneIfNeeded(taskId: string, trace: LangfuseTraceClient): Promise<void>;
}
//# sourceMappingURL=ContextPruner.d.ts.map