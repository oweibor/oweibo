"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.kiloPipelineTool = void 0;
exports.kiloPipelineTool = {
    name: 'kilo_pipeline_submit_task',
    description: 'Submits a software development task to the Kilo 9-stage autonomous pipeline for code generation, TDD-first validation, and deployment.',
    allowHotReload: false,
    inputSchema: {
        type: 'object',
        required: ['instruction', 'scaffoldInput', 'workspacePath', 'trustMode'],
        properties: {
            instruction: { type: 'string', minLength: 10, description: 'Detailed task instruction.' },
            scaffoldInput: { type: 'object' },
            workspacePath: { type: 'string', pattern: '^/workspaces/[a-zA-Z0-9_-]+$' },
            trustMode: { type: 'string', enum: ['supervised', 'graduated'] },
            tokenBudget: { type: 'integer', minimum: 1000, maximum: 100000, default: 76800 },
        },
    },
    outputSchema: {
        type: 'object',
        required: ['taskId', 'status'],
        properties: {
            taskId: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['pending', 'running', 'success', 'failed', 'circuit-open'] },
            stage: { type: 'string' },
            artifacts: { type: 'object' },
            error: { type: 'object' },
            tokensUsed: { type: 'integer' },
        },
    },
    securityContext: {
        permissions: ['kilo:submit', 'workspace:write'],
    },
    handler: async (input) => {
        // Runtime handler — delegates to kilo pipeline via HTTP
        const { instruction, scaffoldInput, workspacePath, trustMode, tokenBudget } = input;
        const baseUrl = process.env.KILO_PIPELINE_URL ?? 'http://localhost:3100';
        const res = await fetch(`${baseUrl}/task`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instruction, scaffoldInput, workspacePath, trustMode, tokenBudget }),
        });
        if (!res.ok)
            throw new Error(`kilo pipeline returned ${res.status}: ${await res.text()}`);
        return res.json();
    },
};
//# sourceMappingURL=kilo-pipeline.tool.js.map