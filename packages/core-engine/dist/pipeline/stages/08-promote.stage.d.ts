import type { IPipelineStage, IStageContext, IStageResult } from '@oweibo/core-contracts';
export declare class PromoteStage implements IPipelineStage {
    readonly name = "promote";
    execute(ctx: IStageContext): Promise<IStageResult>;
}
//# sourceMappingURL=08-promote.stage.d.ts.map