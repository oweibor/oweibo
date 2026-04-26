// packages/core-engine/src/pipeline/stages/06b-compliance-gate.stage.ts
// G19: deterministic compliance gate — runs after semantic-gate, before ADR/promote.
import type { IPipelineStage, IStageContext, IStageResult } from '@oweibo/core-contracts';
import { ComplianceGate } from '../../governance/ComplianceGate.js';

export class ComplianceGateStage implements IPipelineStage {
  readonly name = 'compliance-gate';

  private readonly gate: ComplianceGate;

  constructor(gate: ComplianceGate = new ComplianceGate()) {
    this.gate = gate;
  }

  async execute(ctx: IStageContext): Promise<IStageResult> {
    const { bundle, logger } = ctx;
    const result = this.gate.check(bundle);

    for (const w of result.warnings) {
      logger.warn(`[Stage 06b] ${w.ruleId} (${w.severity}): ${w.message}${w.filePath ? ` @ ${w.filePath}` : ''}`);
    }

    if (!result.passed) {
      const first = result.violations[0];
      const summary = result.violations.slice(0, 5).map(v => `- ${v.ruleId}: ${v.message}${v.filePath ? ` (${v.filePath})` : ''}`).join('\n');
      return {
        passed: false,
        errorCode: 'COMPLIANCE_FAIL',
        message: `Compliance gate: ${result.violations.length} blocking violation(s) (${result.summary.critical} critical, ${result.summary.high} high)\n${summary}`,
        blockPromotion: true,
        recoveryHint: first ? `${first.ruleId}: ${first.message}` : 'Address blocking compliance violations',
      };
    }

    logger.info(`[Stage 06b] Compliance gate PASS. ${result.summary.medium + result.summary.low} non-blocking warnings.`);
    return { passed: true };
  }
}
