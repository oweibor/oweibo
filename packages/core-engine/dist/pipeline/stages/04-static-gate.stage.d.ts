import type { IPipelineStage, IStageContext, IStageResult } from '@oweibo/core-contracts';
export declare class StaticGateStage implements IPipelineStage {
    readonly name = "static-gate";
    execute(ctx: IStageContext): Promise<IStageResult>;
}
//# sourceMappingURL=04-static-gate.stage.d.ts.map