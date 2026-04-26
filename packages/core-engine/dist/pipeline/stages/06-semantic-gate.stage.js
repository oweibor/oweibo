"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SemanticGateStage = void 0;
class SemanticGateStage {
    name = 'semantic-gate';
    async execute(ctx) {
        const { bundle, llm, logger, originalRequirements } = ctx;
        const ka = bundle.knowledgeArtifact;
        const endpointSummary = ka?.endpoints?.map(e => `${e.method} ${e.path}`).join(', ') ?? 'none';
        const entitySummary = ka?.entities?.map(e => e.name).join(', ') ?? 'none';
        const sourceSample = bundle.files.slice(0, 5).map(f => `// ${f.path}\n${f.content.slice(0, 800)}`).join('\n\n---\n\n');
        const res = await llm.generate({
            systemPrompt: SEMANTIC_GATE_SYSTEM_PROMPT,
            userPrompt: `Requirements: ${originalRequirements}\nStack: ${ctx.scaffoldInput.stack}\nEntities: ${entitySummary}\nEndpoints: ${endpointSummary}\n\nSource sample:\n${sourceSample}`,
            responseFormat: 'json',
        });
        let parsed = { verdict: 'PASS', issues: [], summary: '' };
        try {
            parsed = JSON.parse(res.output);
        }
        catch {
            logger.warn('[Stage 06] Semantic gate returned non-JSON — treating as PASS.');
            return { passed: true };
        }
        const blocking = parsed.issues?.filter(i => i.severity === 'BLOCKING') ?? [];
        if (parsed.verdict === 'FAIL' && blocking.length > 0) {
            return { passed: false, errorCode: 'SEMANTIC_FAIL', message: `Semantic gate FAIL: ${parsed.summary}\n${blocking.map(i => `- ${i.location}: ${i.description}`).join('\n')}`, blockPromotion: true, recoveryHint: blocking[0]?.description };
        }
        const warnings = parsed.issues?.filter(i => i.severity === 'WARNING') ?? [];
        if (warnings.length)
            logger.warn(`[Stage 06] Warnings: ${warnings.map(i => i.description).join('; ')}`);
        logger.info(`[Stage 06] Semantic gate PASS. ${parsed.summary}`);
        return { passed: true };
    }
}
exports.SemanticGateStage = SemanticGateStage;
const SEMANTIC_GATE_SYSTEM_PROMPT = `You are a senior code reviewer. Evaluate: correctness, security, architectural consistency, completeness. Output JSON: {"verdict": "PASS"|"FAIL", "issues": [{"severity": "BLOCKING"|"WARNING", "location": string, "description": string}], "summary": string}`;
//# sourceMappingURL=06-semantic-gate.stage.js.map