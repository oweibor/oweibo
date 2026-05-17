"use strict";
/**
 * DocGeneratorPipeline — top-level entry point for doc generation (§4.3.2, v10.5).
 *
 * Wires CodebaseAnalyzer + DocGeneratorOrchestrator with:
 *   - DocAnalyzerCache (incremental analysis)
 *   - AbortController (cancellation)
 *   - TaskEventBus (progress events)
 *   - DryRun short-circuit (C16, v10.5)
 *   - Single shared PromptBudgetEnforcerAdapter across analysis + rendering (CRIT-4)
 *
 * Callers: DocGeneratorWorker (HTTP/queue path) and doc:generate tool (direct path).
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocGeneratorPipeline = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const core_contracts_1 = require("@oweibo/core-contracts");
const CodebaseAnalyzer_js_1 = require("./analysis/CodebaseAnalyzer.js");
const LanguageAnalyzerRegistry_js_1 = require("./analysis/LanguageAnalyzerRegistry.js");
const PatternDetector_js_1 = require("./analysis/PatternDetector.js");
const ArchitectureInferrer_js_1 = require("./analysis/ArchitectureInferrer.js");
const DependencyMapper_js_1 = require("./analysis/DependencyMapper.js");
const DocAnalyzerCache_js_1 = require("./analysis/DocAnalyzerCache.js");
const SemanticAnnotator_js_1 = require("./analysis/SemanticAnnotator.js");
const TypeScriptAnalyzer_js_1 = require("./analysis/analyzers/TypeScriptAnalyzer.js");
const PythonAnalyzer_js_1 = require("./analysis/analyzers/PythonAnalyzer.js");
const GenericAnalyzer_js_1 = require("./analysis/analyzers/GenericAnalyzer.js");
const DocGeneratorOrchestrator_js_1 = require("./rendering/DocGeneratorOrchestrator.js");
const PromptBudgetEnforcerAdapter_js_1 = require("./adapters/PromptBudgetEnforcerAdapter.js");
const index_js_1 = require("./rendering/templates/index.js");
// ── DocGeneratorPipeline ──────────────────────────────────────────────────────
class DocGeneratorPipeline {
    opts;
    registry;
    archInfer;
    depMapper;
    constructor(opts) {
        this.opts = opts;
        const registry = new LanguageAnalyzerRegistry_js_1.LanguageAnalyzerRegistry();
        registry
            .register(new TypeScriptAnalyzer_js_1.TypeScriptAnalyzer())
            .register(new PythonAnalyzer_js_1.PythonAnalyzer())
            .setFallback(new GenericAnalyzer_js_1.GenericAnalyzer());
        this.registry = registry;
        this.archInfer = new ArchitectureInferrer_js_1.ArchitectureInferrer(opts.logger);
        this.depMapper = new DependencyMapper_js_1.DependencyMapper(opts.logger);
    }
    async run(job, signal) {
        const startMs = Date.now();
        const { tenantId, sessionId, rootPath } = job;
        const outputDir = job.outputDir ?? node_path_1.default.join(rootPath, 'docs');
        const dryRun = job.options?.dryRun ?? false;
        const controller = new AbortController();
        const combined = combineSignals(controller.signal, signal);
        await this.opts.eventBus.publish(sessionId, {
            taskId: sessionId,
            type: 'codebase-analysis-started',
            message: `Starting doc generation for ${node_path_1.default.basename(rootPath)}`,
            payload: { tenantId, rootPath, dryRun },
        });
        try {
            // ── Build analysis components ─────────────────────────────────────────────
            const dotOweiboDir = this.opts.dotOweiboDir ?? node_path_1.default.join(rootPath, '.oweibo');
            const docCache = await DocAnalyzerCache_js_1.DocAnalyzerCache.create(dotOweiboDir, this.opts.logger);
            const vectorSearch = this.opts.vectorSearch ?? new core_contracts_1.NoopVectorSearch();
            // One shared budget adapter across analysis + rendering (CRIT-4 / B1).
            // Passing opts.enforcer enables event-bus fallback accounting; passing undefined
            // is valid (tests and embedded callers that have no infrastructure enforcer).
            const budget = new PromptBudgetEnforcerAdapter_js_1.PromptBudgetEnforcerAdapter(this.opts.enforcer, this.opts.globalTokenBudget ?? 80_000, {}, this.opts.logger);
            const semanticAnnotator = new SemanticAnnotator_js_1.SemanticAnnotator(this.opts.llm, budget, this.opts.eventBus, this.opts.logger, vectorSearch, new SemanticAnnotator_js_1.RepoMapBuilder());
            const analyzer = new CodebaseAnalyzer_js_1.CodebaseAnalyzer(this.registry, new PatternDetector_js_1.PatternDetector(), this.archInfer, semanticAnnotator, this.depMapper, docCache, this.opts.llm, this.opts.logger, this.opts.eventBus, vectorSearch);
            const analysisOpts = {
                tenantId,
                sessionId,
                skipLLM: dryRun,
                redactAuthors: job.options?.redactAuthors ?? true,
                ...job.options,
            };
            // ── Phase 1–6: Analysis ───────────────────────────────────────────────────
            const knowledge = await analyzer.analyze(rootPath, analysisOpts, combined);
            await this.opts.eventBus.publish(sessionId, {
                taskId: sessionId,
                type: 'codebase-analysis-complete',
                message: `Analysis complete: ${knowledge.modules.length} modules, ${knowledge.files.length} files`,
                payload: { moduleCount: knowledge.modules.length, fileCount: knowledge.files.length },
            });
            // Templates are built before the dry-run branch so isApplicable() can be called
            // for the dry-run report without a second construction (CRIT-4).
            const templates = (0, index_js_1.buildAllTemplates)(analysisOpts);
            // ── Dry run: return report without rendering ───────────────────────────────
            if (dryRun) {
                const gitAvailable = node_fs_1.default.existsSync(node_path_1.default.join(rootPath, '.git'));
                const report = buildDryRunReport(knowledge, templates, {
                    llm: true,
                    gitAvailable,
                });
                return {
                    sessionId,
                    writtenFiles: [],
                    warnings: knowledge.warnings,
                    dryRunReport: report,
                    durationMs: Date.now() - startMs,
                    tokensSpent: 0,
                };
            }
            // ── Rendering ─────────────────────────────────────────────────────────────
            await this.opts.eventBus.publish(sessionId, {
                taskId: sessionId,
                type: 'doc-generation-started',
                message: 'Rendering documentation templates',
                payload: { tenantId },
            });
            const ctx = { llm: this.opts.llm, tokenBudget: budget };
            const orchOpts = {
                outputDir,
                redactSecrets: true,
            };
            const orchestrator = new DocGeneratorOrchestrator_js_1.DocGeneratorOrchestrator(templates, ctx, orchOpts);
            const result = await orchestrator.run(knowledge, combined);
            for (const w of result.warnings) {
                await this.opts.eventBus.publish(sessionId, {
                    taskId: sessionId,
                    type: 'doc-generation-warning',
                    message: w.message,
                    payload: { ...w.context, code: w.code },
                });
            }
            await this.opts.eventBus.publish(sessionId, {
                taskId: sessionId,
                type: 'doc-generation-complete',
                message: `Documentation written: ${result.writtenFiles.length} files`,
                payload: { writtenFiles: result.writtenFiles, tenantId },
            });
            return {
                sessionId,
                writtenFiles: result.writtenFiles,
                warnings: result.warnings,
                knowledge,
                durationMs: Date.now() - startMs,
                tokensSpent: budget.totalSpent,
            };
        }
        catch (err) {
            if (err.name === 'AbortError') {
                await this.opts.eventBus.publish(sessionId, {
                    taskId: sessionId,
                    type: 'doc-generation-warning',
                    message: 'Doc generation cancelled',
                    payload: { code: 'RUN_CANCELLED', tenantId },
                });
            }
            controller.abort();
            throw err;
        }
    }
    cancel(controller) {
        controller.abort();
    }
}
exports.DocGeneratorPipeline = DocGeneratorPipeline;
// ── Helpers ───────────────────────────────────────────────────────────────────
function combineSignals(...signals) {
    const ctrl = new AbortController();
    for (const sig of signals) {
        if (!sig)
            continue;
        if (sig.aborted) {
            ctrl.abort();
            return ctrl.signal;
        }
        sig.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
    return ctrl.signal;
}
function buildDryRunReport(knowledge, templates, caps) {
    const byLanguage = {};
    for (const f of knowledge.files) {
        byLanguage[f.language] = (byLanguage[f.language] ?? 0) + 1;
    }
    // Probe each template using its own isApplicable() — the authoritative gate (CRIT-4).
    const templatesApplicable = templates
        .map((t) => {
        const check = t.isApplicable(knowledge);
        return { category: t.category, degradationLevel: check.degradationLevel, reason: check.reason };
    })
        .filter((entry) => entry.degradationLevel !== 'skipped');
    const estimatedLLMTokens = Math.round(knowledge.files.length * 120);
    return {
        filesDiscovered: knowledge.files.length,
        byLanguage: byLanguage,
        templatesApplicable,
        requiredCapabilities: [
            {
                capability: 'llm',
                available: caps.llm,
                impact: 'Semantic annotations and LLM-powered sections skipped without LLM',
            },
            {
                capability: 'git',
                available: caps.gitAvailable,
                impact: 'Changelog and inferred-ADR templates degrade to skeleton without git history',
            },
        ],
        estimatedLLMTokens,
        estimatedCostUSD: (estimatedLLMTokens / 1_000_000) * 15,
    };
}
//# sourceMappingURL=DocGeneratorPipeline.js.map