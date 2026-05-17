"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolRegistry = exports.SchemaValidationError = exports.PermissionDeniedError = void 0;
// packages/core-engine/src/tools/ToolRegistry.ts
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Ajv = require('ajv');
const observability_1 = require("@oweibo/observability");
const ajv = new Ajv({ strict: false });
class PermissionDeniedError extends Error {
    constructor(toolName, required, provided) {
        super(`[ToolRegistry] Permission denied for "${toolName}". Required: [${required.join(', ')}]. Got: [${provided.join(', ')}]`);
        this.name = 'PermissionDeniedError';
    }
}
exports.PermissionDeniedError = PermissionDeniedError;
class SchemaValidationError extends Error {
    constructor(toolName, direction, detail) {
        super(`[ToolRegistry] ${direction} schema validation failed for "${toolName}": ${detail}`);
        this.name = 'SchemaValidationError';
    }
}
exports.SchemaValidationError = SchemaValidationError;
class ToolRegistry {
    qdrant;
    embedFn;
    tools = new Map();
    COLLECTION = 'tool-embeddings';
    constructor(qdrant, embedFn) {
        this.qdrant = qdrant;
        this.embedFn = embedFn;
    }
    async register(tool) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (!ajv.validateSchema(tool.inputSchema)) {
            throw new Error(`[ToolRegistry] Invalid input schema for tool "${tool.name}": ${ajv.errorsText()}`);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (tool.outputSchema && !ajv.validateSchema(tool.outputSchema)) {
            throw new Error(`[ToolRegistry] Invalid output schema for tool "${tool.name}": ${ajv.errorsText()}`);
        }
        if (this.tools.has(tool.name) && !tool.allowHotReload) {
            throw new Error(`[ToolRegistry] Tool "${tool.name}" already registered. Set allowHotReload=true to replace.`);
        }
        this.tools.set(tool.name, tool);
        try {
            const embedding = await this.embed(`${tool.name}: ${tool.description}`);
            await this.qdrant.upsert(this.COLLECTION, {
                points: [{ id: this.nameToId(tool.name), vector: embedding, payload: { name: tool.name } }],
            });
        }
        catch {
            // Qdrant unavailable at register time — tool is still usable via name lookup
        }
    }
    async semanticSearch(query, topK = 5) {
        try {
            const embedding = await this.embed(query);
            const results = await this.qdrant.search(this.COLLECTION, {
                vector: embedding,
                limit: topK,
                with_payload: true,
            });
            return results
                .map(r => this.tools.get(r.payload?.['name']))
                .filter((t) => t !== undefined);
        }
        catch {
            // Qdrant unavailable — fall back to all registered tools
            return [...this.tools.values()].slice(0, topK);
        }
    }
    async invoke(name, input, securityContext, taskCtx) {
        const tool = this.tools.get(name);
        if (!tool)
            throw new Error(`[ToolRegistry] Unknown tool: "${name}"`);
        const requiredPerms = tool.securityContext?.permissions ?? [];
        const permitted = requiredPerms.every(p => securityContext.permissions.includes(p));
        if (!permitted) {
            throw new PermissionDeniedError(name, requiredPerms, securityContext.permissions);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const validate = ajv.compile(tool.inputSchema);
        if (!validate(input)) {
            throw new SchemaValidationError(name, 'input', ajv.errorsText(validate.errors) ?? '');
        }
        const spanCtx = taskCtx ?? { tenantId: '', userId: '', taskId: '' };
        const spanOpts = { toolName: name, toolType: 'function' };
        return (0, observability_1.withToolSpan)(spanOpts, spanCtx, async () => {
            const startMs = Date.now();
            let output;
            try {
                output = tool.handler ? await tool.handler(input) : undefined;
            }
            catch (err) {
                return {
                    toolName: name,
                    status: 'error',
                    durationMs: Date.now() - startMs,
                    error: err instanceof Error ? err.message : String(err),
                    tokensUsed: 0,
                };
            }
            if (tool.outputSchema) {
                const validateOut = ajv.compile(tool.outputSchema);
                if (!validateOut(output)) {
                    throw new SchemaValidationError(name, 'output', ajv.errorsText(validateOut.errors) ?? '');
                }
            }
            return { toolName: name, status: 'success', output, durationMs: Date.now() - startMs, tokensUsed: 0 };
        });
    }
    list() {
        return [...this.tools.values()];
    }
    nameToId(name) {
        let hash = 0;
        for (const c of name)
            hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
        return hash;
    }
    async embed(text) {
        if (this.embedFn)
            return this.embedFn(text);
        const res = await fetch('http://localhost:11434/api/embeddings', {
            method: 'POST',
            body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
        });
        const data = await res.json();
        return data.embedding;
    }
}
exports.ToolRegistry = ToolRegistry;
//# sourceMappingURL=ToolRegistry.js.map