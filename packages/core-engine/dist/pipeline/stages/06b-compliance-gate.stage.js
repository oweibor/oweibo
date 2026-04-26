"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ComplianceGateStage = void 0;
const ComplianceGate_js_1 = require("../../governance/ComplianceGate.js");
class ComplianceGateStage {
    name = 'compliance-gate';
    gate;
    constructor(gate = new ComplianceGate_js_1.ComplianceGate()) {
        this.gate = gate;
    }
    async execute(ctx) {
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
exports.ComplianceGateStage = ComplianceGateStage;
//# sourceMappingURL=06b-compliance-gate.stage.js.map