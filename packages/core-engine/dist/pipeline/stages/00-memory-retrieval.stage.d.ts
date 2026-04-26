import type { IPipelineStage, IStageContext, IStageResult } from '@oweibo/core-contracts';
export declare class MemoryRetrievalStage implements IPipelineStage {
    readonly name = "memory-retrieval";
    execute(ctx: IStageContext): Promise<IStageResult>;
}
//# sourceMappingURL=00-memory-retrieval.stage.d.ts.map