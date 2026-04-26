import type { IPipelineStage, IStageContext, IStageResult } from '@oweibo/core-contracts';
export declare class OrchestrateStage implements IPipelineStage {
    readonly name = "orchestrate";
    execute(ctx: IStageContext): Promise<IStageResult>;
}
//# sourceMappingURL=02-orchestrate.stage.d.ts.map