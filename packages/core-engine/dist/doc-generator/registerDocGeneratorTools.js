"use strict";
/**
 * registerDocGeneratorTools — registers the doc:generate tool in ToolRegistry (§4.3.5, v10.5).
 *
 * Called from main.ts alongside registerGeneralCodingTools(). An agent editing a
 * codebase via general-coding can invoke doc:generate as a DAG node.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerDocGeneratorTools = registerDocGeneratorTools;
function registerDocGeneratorTools(toolRegistry, pipeline) {
    void toolRegistry.register({
        name: 'doc:generate',
        description: 'Analyze a codebase and generate comprehensive documentation (architecture, API reference, ADRs, dependency map, and more).',
        inputSchema: {
            type: 'object',
            required: ['repoPath', 'tenantId'],
            properties: {
                repoPath: {
                    type: 'string',
                    description: 'Absolute path to the repository root to analyze',
                },
                tenantId: {
                    type: 'string',
                    description: 'Tenant identifier for quota and auth scoping',
                },
                options: {
                    type: 'object',
                    properties: {
                        skipLLM: { type: 'boolean' },
                        dryRun: { type: 'boolean' },
                        redactAuthors: { type: 'boolean' },
                        maxFiles: { type: 'number' },
                        outputDir: { type: 'string' },
                        excludePatterns: { type: 'array', items: { type: 'string' } },
                    },
                },
            },
        },
        handler: async (input) => {
            const req = input;
            const sessionId = `doc-tool-${Date.now()}`;
            return pipeline.run({
                tenantId: req.tenantId,
                sessionId,
                rootPath: req.repoPath,
                options: req.options,
            });
        },
    });
}
//# sourceMappingURL=registerDocGeneratorTools.js.map