import type { IPipelineStage, IStageContext, IStageResult } from '@oweibo/core-contracts';
export declare class CriticGateStage implements IPipelineStage {
    readonly name = "critic-gate";
    execute(ctx: IStageContext): Promise<IStageResult>;
}
//# sourceMappingURL=03b-critic-gate.stage.d.ts.map