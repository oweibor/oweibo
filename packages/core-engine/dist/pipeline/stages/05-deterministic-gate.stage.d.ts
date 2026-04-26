import type { IPipelineStage, IStageContext, IStageResult } from '@oweibo/core-contracts';
export declare class DeterministicGateStage implements IPipelineStage {
    readonly name = "deterministic-gate";
    execute(ctx: IStageContext): Promise<IStageResult>;
}
//# sourceMappingURL=05-deterministic-gate.stage.d.ts.map