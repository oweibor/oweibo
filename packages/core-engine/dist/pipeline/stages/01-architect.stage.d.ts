import type { CanonicalRole, IPipelineStage, IStageContext, IStageResult } from '@oweibo/core-contracts';
export declare class ArchitectStage implements IPipelineStage {
    readonly name: CanonicalRole;
    execute(ctx: IStageContext): Promise<IStageResult>;
}
//# sourceMappingURL=01-architect.stage.d.ts.map