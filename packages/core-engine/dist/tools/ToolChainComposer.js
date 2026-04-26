"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolChainComposer = exports.ToolChainError = void 0;
class ToolChainError extends Error {
    stepId;
    toolName;
    constructor(stepId, toolName, detail) {
        super(`[ToolChain] Step "${stepId}" (tool: "${toolName}") failed: ${detail}`);
        this.stepId = stepId;
        this.toolName = toolName;
        this.name = 'ToolChainError';
    }
}
exports.ToolChainError = ToolChainError;
class ToolChainComposer {
    registry;
    constructor(registry) {
        this.registry = registry;
    }
    async execute(steps, initialContext, secCtx) {
        const stepOutputs = { _initial: initialContext };
        const results = [];
        const chainStart = Date.now();
        for (const [idx, step] of steps.entries()) {
            const stepId = `step_${idx}_${step.toolName}`;
            const resolvedInput = this.resolveInput(step.inputMapping, stepOutputs);
            const result = await this.registry.invoke(step.toolName, resolvedInput, secCtx);
            if (result.status === 'error') {
                throw new ToolChainError(stepId, step.toolName, result.error ?? 'unknown');
            }
            stepOutputs[stepId] = result.output;
            results.push({ stepId, toolName: step.toolName, output: result.output, durationMs: result.durationMs });
        }
        return {
            steps: results,
            finalOutput: results.at(-1)?.output,
            totalDurationMs: Date.now() - chainStart,
        };
    }
    resolveInput(mapping, outputs) {
        return Object.fromEntries(Object.entries(mapping).map(([key, spec]) => [
            key,
            typeof spec === 'string' ? spec : this.dotPath(outputs[spec.from], spec.path),
        ]));
    }
    dotPath(obj, path) {
        return path.split('.').reduce((acc, k) => acc?.[k], obj);
    }
}
exports.ToolChainComposer = ToolChainComposer;
//# sourceMappingURL=ToolChainComposer.js.map