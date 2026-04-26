import type { IPipelineStage, IStageContext, IStageResult } from '@oweibo/core-contracts';
export declare class ADRGateStage implements IPipelineStage {
    readonly name = "adr-gate";
    execute(ctx: IStageContext): Promise<IStageResult>;
}
//# sourceMappingURL=07-adr-gate.stage.d.ts.map