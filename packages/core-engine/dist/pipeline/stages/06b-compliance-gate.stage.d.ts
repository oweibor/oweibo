import type { IPipelineStage, IStageContext, IStageResult } from '@oweibo/core-contracts';
import { ComplianceGate } from '../../governance/ComplianceGate.js';
export declare class ComplianceGateStage implements IPipelineStage {
    readonly name = "compliance-gate";
    private readonly gate;
    constructor(gate?: ComplianceGate);
    execute(ctx: IStageContext): Promise<IStageResult>;
}
//# sourceMappingURL=06b-compliance-gate.stage.d.ts.map