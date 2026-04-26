import type { IPipelineStage, IStageContext, IStageResult } from '@oweibo/core-contracts';
export declare class DocumentationStage implements IPipelineStage {
    readonly name = "documentation";
    execute(ctx: IStageContext): Promise<IStageResult>;
}
//# sourceMappingURL=09-documentation.stage.d.ts.map