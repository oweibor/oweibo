import type { IPipelineStage, IStageContext, IStageResult } from '@oweibo/core-contracts';
export declare class TDDGateStage implements IPipelineStage {
    readonly name = "tdd-gate";
    execute(ctx: IStageContext): Promise<IStageResult>;
}
//# sourceMappingURL=03-tdd-gate.stage.d.ts.map