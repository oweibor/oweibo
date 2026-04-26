"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryRetrievalStage = void 0;
class MemoryRetrievalStage {
    name = 'memory-retrieval';
    async execute(ctx) {
        const { memory, scaffoldInput, logger } = ctx;
        const recalled = await memory.recall(`${scaffoldInput.appName} ${scaffoldInput.stack} ${scaffoldInput.features.join(' ')}`, ['successful-strategy', 'tool-heuristic', 'domain-pattern'], 8);
        ctx['originalRequirements'] =
            `App: ${scaffoldInput.appName}\nStack: ${scaffoldInput.stack}\nFeatures: ${scaffoldInput.features.join(', ')}\n` +
                (recalled.length ? `Relevant past strategies:\n${recalled.map(m => `- ${m.summary}`).join('\n')}` : 'No relevant past strategies found.');
        logger.info(`[Stage 00] Memory retrieval: ${recalled.length} entries recalled.`);
        return { passed: true };
    }
}
exports.MemoryRetrievalStage = MemoryRetrievalStage;
//# sourceMappingURL=00-memory-retrieval.stage.js.map