import type { IPipelineStage, IStageContext, IStageResult } from '@oweibo/core-contracts';
export declare class SmokeTestStage implements IPipelineStage {
    readonly name = "smoke-test";
    execute(ctx: IStageContext): Promise<IStageResult>;
}
//# sourceMappingURL=08b-smoke-test.stage.d.ts.map