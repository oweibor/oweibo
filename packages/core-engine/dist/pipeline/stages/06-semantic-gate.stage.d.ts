import type { IPipelineStage, IStageContext, IStageResult } from '@oweibo/core-contracts';
export declare class SemanticGateStage implements IPipelineStage {
    readonly name = "semantic-gate";
    execute(ctx: IStageContext): Promise<IStageResult>;
}
//# sourceMappingURL=06-semantic-gate.stage.d.ts.map