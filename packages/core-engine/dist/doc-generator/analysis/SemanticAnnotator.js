"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SemanticAnnotator = exports.RepoMapBuilder = void 0;
const DocGeneratorPrompts_js_1 = require("../prompts/DocGeneratorPrompts.js");
// ─── RepoMapBuilder stub ──────────────────────────────────────────────────────
/** Builds a compact token-limited summary of the repo for LLM context. */
class RepoMapBuilder {
    build(knowledge, maxTokens) {
        const lines = [];
        if (knowledge.projectName)
            lines.push(`Project: ${knowledge.projectName}`);
        if (knowledge.languages)
            lines.push(`Languages: ${knowledge.languages.join(', ')}`);
        if (knowledge.totalFiles)
            lines.push(`Files: ${knowledge.totalFiles}`);
        if (knowledge.modules) {
            lines.push(`Modules: ${knowledge.modules.map((m) => m.name).join(', ')}`);
        }
        const joined = lines.join('\n');
        // Rough token estimate: 1 token ≈ 4 chars
        const maxChars = maxTokens * 4;
        return joined.length > maxChars ? joined.slice(0, maxChars) + '\n...(truncated)' : joined;
    }
}
exports.RepoMapBuilder = RepoMapBuilder;
class SemanticAnnotator {
    llm;
    tokenBudget;
    eventBus;
    logger;
    vectorSearch;
    repoMap;
    options;
    constructor(llm, tokenBudget, eventBus, logger, vectorSearch, repoMap, options = {}) {
        this.llm = llm;
        this.tokenBudget = tokenBudget;
        this.eventBus = eventBus;
        this.logger = logger;
        this.vectorSearch = vectorSearch;
        this.repoMap = repoMap;
        this.options = options;
    }
    /**
     * Enriches a partial CodebaseKnowledge with LLM-generated annotations.
     * On any LLM failure (BudgetExhaustedError, timeout), emits a warning and
     * returns the structural-only knowledge with empty semantic fields.
     *
     * Never throws — docs always ship, degraded quality flagged in warnings.
     */
    async annotate(knowledge, signal) {
        signal?.throwIfAborted();
        const warnings = [];
        if (this.options.skipLLM) {
            return { projectSummary: '', gettingStarted: '', conventions: [], inferredADRs: knowledge.inferredADRs ?? [], warnings };
        }
        const repoCtx = this.repoMap.build(knowledge, 2_000);
        // Project summary
        const summaryResult = await this.safeCall(DocGeneratorPrompts_js_1.DOC_GEN_PHASES.PROJECT_SUMMARY, DocGeneratorPrompts_js_1.PHASE_TOKEN_BUDGETS['doc-project-summary'].input, () => this.callLLM(DocGeneratorPrompts_js_1.PROJECT_SUMMARY_SYSTEM_PROMPT, (0, DocGeneratorPrompts_js_1.PROJECT_SUMMARY_USER_PROMPT)(repoCtx)), signal);
        if (summaryResult.warning)
            warnings.push(summaryResult.warning);
        signal?.throwIfAborted();
        // Convention detection
        const convResult = await this.safeCall(DocGeneratorPrompts_js_1.DOC_GEN_PHASES.CONVENTIONS, DocGeneratorPrompts_js_1.PHASE_TOKEN_BUDGETS['doc-conventions'].input, () => {
            const symbolSample = knowledge.symbols.slice(0, 50).map((s) => `${s.kind} ${s.name}`).join('\n');
            return this.callLLM(DocGeneratorPrompts_js_1.CONVENTIONS_SYSTEM_PROMPT, (0, DocGeneratorPrompts_js_1.CONVENTIONS_USER_PROMPT)(symbolSample));
        }, signal);
        if (convResult.warning)
            warnings.push(convResult.warning);
        signal?.throwIfAborted();
        // Getting started
        const gettingStartedResult = await this.safeCall(DocGeneratorPrompts_js_1.DOC_GEN_PHASES.GETTING_STARTED, DocGeneratorPrompts_js_1.PHASE_TOKEN_BUDGETS['doc-getting-started'].input, () => this.callLLM(DocGeneratorPrompts_js_1.GETTING_STARTED_SYSTEM_PROMPT, (0, DocGeneratorPrompts_js_1.GETTING_STARTED_USER_PROMPT)(repoCtx)), signal);
        if (gettingStartedResult.warning)
            warnings.push(gettingStartedResult.warning);
        signal?.throwIfAborted();
        // ADR inference from detected patterns
        const adrResult = await this.safeCall(DocGeneratorPrompts_js_1.DOC_GEN_PHASES.ADR_INFER, DocGeneratorPrompts_js_1.PHASE_TOKEN_BUDGETS['doc-adr-infer'].input, () => {
            const evidence = knowledge.patterns
                .map((p) => `Pattern: ${p.name} (confidence ${p.confidence.toFixed(2)})\nDescription: ${p.description}`)
                .join('\n\n');
            return this.callLLM(DocGeneratorPrompts_js_1.ADR_INFER_SYSTEM_PROMPT, (0, DocGeneratorPrompts_js_1.ADR_INFER_USER_PROMPT)(evidence));
        }, signal);
        if (adrResult.warning)
            warnings.push(adrResult.warning);
        return {
            projectSummary: summaryResult.value?.summary ?? '',
            gettingStarted: typeof gettingStartedResult.value === 'string' ? gettingStartedResult.value : '',
            conventions: Array.isArray(convResult.value) ? convResult.value : [],
            inferredADRs: Array.isArray(adrResult.value) ? adrResult.value : (knowledge.inferredADRs ?? []),
            warnings,
        };
    }
    // ── Module description enrichment ────────────────────────────────────────────
    async enrichModuleDescriptions(modules, signal) {
        const result = new Map();
        if (this.options.skipLLM)
            return result;
        for (const mod of modules) {
            signal?.throwIfAborted();
            const apiCtx = mod.publicApi.slice(0, 20).map((s) => `${s.kind} ${s.name}`).join('\n');
            const call = await this.safeCall(DocGeneratorPrompts_js_1.DOC_GEN_PHASES.MODULE_DESC, DocGeneratorPrompts_js_1.PHASE_TOKEN_BUDGETS['doc-module-desc'].input, () => this.callLLM(DocGeneratorPrompts_js_1.MODULE_DESC_SYSTEM_PROMPT, (0, DocGeneratorPrompts_js_1.MODULE_DESC_USER_PROMPT)(mod.name, apiCtx)), signal);
            if (call.value?.description)
                result.set(mod.name, call.value.description);
        }
        return result;
    }
    // ── Dependency purpose annotation ────────────────────────────────────────────
    async enrichDependencyPurposes(packageNames, signal) {
        const result = new Map();
        if (this.options.skipLLM)
            return result;
        const BATCH = 20;
        for (let i = 0; i < packageNames.length; i += BATCH) {
            signal?.throwIfAborted();
            const batch = packageNames.slice(i, i + BATCH);
            const call = await this.safeCall(DocGeneratorPrompts_js_1.DOC_GEN_PHASES.DEP_PURPOSE, DocGeneratorPrompts_js_1.PHASE_TOKEN_BUDGETS['doc-dep-purpose'].input, () => this.callLLM(DocGeneratorPrompts_js_1.DEP_PURPOSE_SYSTEM_PROMPT, (0, DocGeneratorPrompts_js_1.DEP_PURPOSE_USER_PROMPT)(batch)), signal);
            if (call.value) {
                for (const [name, purpose] of Object.entries(call.value)) {
                    result.set(name, purpose);
                }
            }
        }
        return result;
    }
    // ── LLM call helpers ──────────────────────────────────────────────────────────
    async callLLM(systemPrompt, userPrompt) {
        const req = {
            systemPrompt,
            userPrompt,
            maxTokens: 2_000,
        };
        const response = await this.llm.generate(req);
        const text = response.output ?? '';
        try {
            const jsonMatch = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
            if (jsonMatch)
                return JSON.parse(jsonMatch[0]);
            return text;
        }
        catch {
            return text;
        }
    }
    async safeCall(phase, maxTokens, fn, signal) {
        try {
            signal?.throwIfAborted();
            const value = await this.tokenBudget.withinBudget(phase, maxTokens, fn);
            return { value: value, warning: null };
        }
        catch (err) {
            const code = this.classifyLLMError(err);
            this.logger.warn({ phase, err }, `LLM call failed: ${code}`);
            return {
                value: null,
                warning: {
                    code,
                    message: `${phase} LLM call failed: ${err.message}`,
                    context: { phase },
                },
            };
        }
    }
    classifyLLMError(err) {
        const msg = err.message ?? '';
        if (msg.includes('BudgetExhausted') || err.phase)
            return 'LLM_BUDGET_EXHAUSTED';
        if (msg.includes('timeout') || msg.includes('TIMEOUT'))
            return 'LLM_TIMEOUT';
        return 'LLM_RESPONSE_INVALID';
    }
}
exports.SemanticAnnotator = SemanticAnnotator;
//# sourceMappingURL=SemanticAnnotator.js.map