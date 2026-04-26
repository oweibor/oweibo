"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startAgentTrace = startAgentTrace;
exports.scoreTask = scoreTask;
exports.tracedToolCall = tracedToolCall;
exports.tracedGeneration = tracedGeneration;
exports.flushTraces = flushTraces;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _langfuse = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getLangfuseClient() {
    if (_langfuse)
        return _langfuse;
    const secretKey = process.env.LANGFUSE_SECRET_KEY;
    const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
    if (!secretKey || !publicKey)
        return null;
    try {
        // Dynamic import avoids dual-declaration conflict between CJS/ESM langfuse types
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Langfuse } = require('langfuse');
        _langfuse = new Langfuse({
            secretKey,
            publicKey,
            baseUrl: process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com',
            flushAt: 10,
            flushInterval: 5000,
        });
        return _langfuse;
    }
    catch {
        return null;
    }
}
function createNoOpTrace(taskId) {
    const noop = () => { };
    const noopSpan = { end: noop, update: noop };
    return {
        id: taskId,
        update: noop,
        score: noop,
        span: () => noopSpan,
        generation: () => noopSpan,
    };
}
async function startAgentTrace(taskId, description, userId) {
    const lf = await getLangfuseClient();
    if (!lf)
        return createNoOpTrace(taskId);
    try {
        return lf.trace({
            id: taskId,
            name: description,
            userId,
            metadata: { taskId, startedAt: new Date().toISOString() },
        });
    }
    catch {
        return createNoOpTrace(taskId);
    }
}
async function scoreTask(trace, scores) {
    for (const [name, value] of Object.entries(scores)) {
        if (value === undefined)
            continue;
        try {
            trace.score({ name, value });
        }
        catch {
            // Non-fatal — observability failure must never break the pipeline
        }
    }
}
async function tracedToolCall(trace, toolName, input, fn) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let span;
    const startMs = Date.now();
    try {
        span = trace.span({
            name: `tool:${toolName}`,
            input: JSON.stringify(input).slice(0, 1000),
        });
    }
    catch {
        return fn();
    }
    try {
        const result = await fn();
        span?.end?.({ output: JSON.stringify(result).slice(0, 1000) });
        return result;
    }
    catch (err) {
        span?.end?.({ output: String(err), level: 'ERROR' });
        throw err;
    }
    finally {
        void startMs; // consumed via metadata on happy path
    }
}
async function tracedGeneration(trace, name, model, systemPrompt, userPrompt, fn) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let generation;
    try {
        generation = trace.generation({
            name,
            model,
            input: [
                { role: 'system', content: systemPrompt.slice(0, 500) },
                { role: 'user', content: userPrompt.slice(0, 500) },
            ],
        });
    }
    catch {
        return fn();
    }
    try {
        const result = await fn();
        generation?.end?.({
            output: result.output.slice(0, 1000),
            usage: {
                promptTokens: result.promptTokens,
                completionTokens: result.completionTokens,
                totalTokens: (result.promptTokens ?? 0) + (result.completionTokens ?? 0),
            },
        });
        return result;
    }
    catch (err) {
        generation?.end?.({ output: String(err), level: 'ERROR' });
        throw err;
    }
}
async function flushTraces() {
    if (_langfuse) {
        try {
            await _langfuse.flushAsync?.();
        }
        catch {
            // Non-fatal
        }
    }
}
//# sourceMappingURL=LangfuseTracer.js.map