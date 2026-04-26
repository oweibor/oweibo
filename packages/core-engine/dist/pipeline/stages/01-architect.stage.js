"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArchitectStage = void 0;
class ArchitectStage {
    name = 'architect';
    async execute(ctx) {
        const { bundle, logger } = ctx;
        if (!bundle.files || bundle.files.length === 0) {
            return { passed: false, errorCode: 'NO_FILES', message: 'ArchitectAgent produced no source files.', blockPromotion: true };
        }
        if (!bundle.knowledgeArtifact) {
            return { passed: false, errorCode: 'NO_KNOWLEDGE_ARTIFACT', message: 'ArchitectAgent produced no knowledgeArtifact.', blockPromotion: true };
        }
        if (!bundle.knowledgeArtifact.userFlows?.length)
            logger.warn('[Stage 01] knowledgeArtifact.userFlows is empty.');
        if (!bundle.knowledgeArtifact.glossary?.length)
            logger.warn('[Stage 01] knowledgeArtifact.glossary is empty.');
        for (const f of [...bundle.files, ...bundle.testFiles]) {
            if (!f.path || !f.content) {
                return { passed: false, errorCode: 'MALFORMED_FILE', message: `File missing path or content: ${JSON.stringify(f).slice(0, 100)}`, blockPromotion: true };
            }
        }
        logger.info(`[Stage 01] Architect validation passed. ${bundle.files.length} source files, ${bundle.testFiles.length} test files.`);
        return { passed: true };
    }
}
exports.ArchitectStage = ArchitectStage;
//# sourceMappingURL=01-architect.stage.js.map