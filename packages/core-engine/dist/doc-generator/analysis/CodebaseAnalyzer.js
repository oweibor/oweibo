"use strict";
/**
 * CodebaseAnalyzer — the analysis orchestrator (§4.1.1, v10.5).
 *
 * Phases:
 *   1. Discovery       — walkFs() builds the file list (respecting excludes/includes)
 *   2. Structural      — LanguageAnalyzerRegistry.analyzeDirectory() per-language
 *   3. Module Boundary — ArchitectureInferrer
 *   4. Pattern         — PatternDetector
 *   5. Dependency      — DependencyMapper
 *   6. Semantic        — SemanticAnnotator (LLM; skipped when skipLLM=true)
 *
 * Design principles:
 *   - Deterministic first, LLM second.
 *   - Incremental: DocAnalyzerCache skips unchanged files.
 *   - AbortSignal threaded through all phases (A5, v10.3).
 *   - All dependencies injected — no hidden globals.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodebaseAnalyzer = void 0;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const minimatch_1 = require("minimatch");
const validateGlobPatterns_js_1 = require("./validateGlobPatterns.js");
const DEFAULT_EXCLUDES = [
    '**/node_modules/**',
    '**/dist/**',
    '**/.git/**',
    '**/.oweibo/**',
    '**/doc-generator/**',
];
const DEFAULT_MAX_FILES = 5_000;
const DEFAULT_MAX_FILE_SIZE = 1_048_576; // 1 MB
const DEFAULT_MAX_DEPTH = 10;
// ─── CodebaseAnalyzer ─────────────────────────────────────────────────────────
class CodebaseAnalyzer {
    registry;
    patternDetector;
    archInferrer;
    semanticAnnotator;
    depMapper;
    docCache;
    llm;
    logger;
    eventBus;
    vectorSearch;
    constructor(registry, patternDetector, archInferrer, semanticAnnotator, depMapper, docCache, llm, logger, eventBus, vectorSearch) {
        this.registry = registry;
        this.patternDetector = patternDetector;
        this.archInferrer = archInferrer;
        this.semanticAnnotator = semanticAnnotator;
        this.depMapper = depMapper;
        this.docCache = docCache;
        this.llm = llm;
        this.logger = logger;
        this.eventBus = eventBus;
        this.vectorSearch = vectorSearch;
    }
    async analyze(rootPath, options, signal) {
        const startMs = Date.now();
        const warnings = [];
        const opts = options ?? { tenantId: 'default', sessionId: 'default' };
        // ── Phase 1: Discovery ────────────────────────────────────────────────────
        this.emitProgress('discovery', 0, 0, opts.sessionId);
        signal?.throwIfAborted();
        const validExcludes = (0, validateGlobPatterns_js_1.validateGlobPatterns)(opts.selfMode
            ? ['**/doc-generator/**']
            : (opts.excludePatterns ?? DEFAULT_EXCLUDES), this.logger);
        const validIncludes = (0, validateGlobPatterns_js_1.validateGlobPatterns)(opts.includePatterns ?? [], this.logger);
        const allFiles = await this.walkFs(rootPath, {
            excludes: validExcludes,
            includes: validIncludes,
            maxFiles: opts.maxFiles ?? DEFAULT_MAX_FILES,
            maxFileSize: opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE,
            maxDepth: opts.maxDepth ?? DEFAULT_MAX_DEPTH,
        }, warnings, signal);
        // ── Dry-run early exit (C16, HIGH-2) ─────────────────────────────────────
        // Short-circuit after phase 1 only: return a skeleton knowledge carrying the
        // file list so DocGeneratorPipeline can build a DryRunReport without running
        // AST extraction, LLM calls, or any file writes.
        if (opts.dryRun) {
            const byLang = classifyFilesByExtension(allFiles);
            const durationMs = Date.now() - startMs;
            return {
                projectName: node_path_1.default.basename(rootPath),
                rootPath,
                analyzedAt: new Date().toISOString(),
                analysisDurationMs: durationMs,
                languages: Object.keys(byLang),
                totalFiles: allFiles.length,
                totalLines: 0,
                files: allFiles.map((f) => ({
                    filePath: f,
                    language: detectLanguage(f),
                    lineCount: 0,
                    complexity: 1,
                    exports: [],
                    imports: [],
                    dependencies: [],
                })),
                symbols: [],
                callGraph: [],
                modules: [],
                patterns: [],
                dataFlows: [],
                inferredADRs: [],
                externalDependencies: [],
                internalDependencyGraph: [],
                projectSummary: '',
                gettingStarted: undefined,
                conventions: [],
                warnings,
            };
        }
        // ── Phase 2: Structural extraction ───────────────────────────────────────
        this.emitProgress('structural-extraction', 0, allFiles.length, opts.sessionId);
        signal?.throwIfAborted();
        const { analyses, skipped } = await this.registry.analyzeDirectory(rootPath, allFiles, signal);
        if (skipped.length > 0) {
            this.logger.warn({ count: skipped.length }, 'Files skipped (no analyzer)');
        }
        // ── Phase 3: Module boundary detection ───────────────────────────────────
        this.emitProgress('module-boundaries', analyses.length, allFiles.length, opts.sessionId);
        signal?.throwIfAborted();
        const rawModules = await this.archInferrer.infer(rootPath, analyses, signal);
        // ── Phase 4: Pattern detection ───────────────────────────────────────────
        this.emitProgress('pattern-detection', analyses.length, allFiles.length, opts.sessionId);
        signal?.throwIfAborted();
        const detectedPatterns = this.patternDetector.detect(analyses, allFiles);
        const architecturalPatterns = detectedPatterns
            .filter((p) => p.confidence > 0)
            .map((p) => ({
            name: p.kind,
            confidence: p.confidence,
            evidence: p.evidence,
            description: p.description,
            category: classifyPatternCategory(p.kind),
        }));
        // ── Phase 5: Dependency mapping ──────────────────────────────────────────
        this.emitProgress('dependency-mapping', analyses.length, allFiles.length, opts.sessionId);
        signal?.throwIfAborted();
        const rawDeps = await this.depMapper.map(rootPath, signal);
        const externalDeps = rawDeps.map((d) => ({
            name: d.name,
            version: d.version ?? 'unknown',
            versionSource: mapVersionSource(d.versionSource),
            purpose: d.purpose || undefined,
            isDev: d.isDev,
            license: d.license,
            licenseSource: mapLicenseSource(d.licenseSource),
        }));
        // Aggregate all symbols and call graph
        const allSymbols = analyses.flatMap((a) => a.exports);
        const callEdges = await this.extractCallGraph(analyses, signal);
        const modules = buildModuleBoundaries(rawModules, analyses, allSymbols);
        // Build partial knowledge for semantic phase
        const partialKnowledge = {
            projectName: node_path_1.default.basename(rootPath),
            rootPath,
            analyzedAt: new Date().toISOString(),
            analysisDurationMs: 0,
            languages: uniqueLanguages(analyses),
            totalFiles: analyses.length,
            totalLines: analyses.reduce((n, a) => n + a.lineCount, 0),
            files: analyses,
            symbols: allSymbols,
            callGraph: callEdges,
            modules,
            patterns: architecturalPatterns,
            dataFlows: [],
            inferredADRs: [],
            externalDependencies: externalDeps,
            internalDependencyGraph: [],
            warnings: [...warnings],
        };
        // ── Phase 6: Semantic enrichment ─────────────────────────────────────────
        this.emitProgress('semantic-enrichment', analyses.length, allFiles.length, opts.sessionId);
        signal?.throwIfAborted();
        const semantic = await this.semanticAnnotator.annotate(partialKnowledge, signal);
        warnings.push(...semantic.warnings);
        const durationMs = Date.now() - startMs;
        const knowledge = {
            ...partialKnowledge,
            analysisDurationMs: durationMs,
            projectSummary: semantic.projectSummary,
            gettingStarted: semantic.gettingStarted || undefined,
            conventions: semantic.conventions,
            inferredADRs: semantic.inferredADRs,
            warnings,
        };
        this.emitComplete(opts.sessionId, analyses.length);
        return knowledge;
    }
    async incrementalAnalyze(rootPath, previous, changedFiles, signal) {
        // Re-analyze only changed files; merge with previous for unchanged
        const unchanged = previous.files.filter((f) => !changedFiles.includes(f.filePath));
        const { analyses: changed } = await this.registry.analyzeDirectory(rootPath, changedFiles, signal);
        const merged = [...unchanged, ...changed];
        const pseudoKnowledge = {
            ...previous,
            files: merged,
            symbols: merged.flatMap((a) => a.exports),
            totalFiles: merged.length,
            totalLines: merged.reduce((n, a) => n + a.lineCount, 0),
            analyzedAt: new Date().toISOString(),
        };
        return pseudoKnowledge;
    }
    // ── Internal helpers ─────────────────────────────────────────────────────────
    async walkFs(rootPath, opts, warnings, signal) {
        const results = [];
        const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.py', '.go', '.rs', '.java']);
        const walk = async (dir, depth) => {
            if (depth > opts.maxDepth) {
                warnings.push({ code: 'MAX_DEPTH_EXCEEDED', message: `Depth ${depth} exceeds max ${opts.maxDepth}`, context: { dir } });
                return;
            }
            if (results.length >= opts.maxFiles)
                return;
            signal?.throwIfAborted();
            let entries;
            try {
                entries = await promises_1.default.readdir(dir, { withFileTypes: true, encoding: 'utf-8' });
            }
            catch {
                return;
            }
            for (const entry of entries) {
                if (results.length >= opts.maxFiles) {
                    warnings.push({ code: 'MAX_FILES_EXCEEDED', message: `Hit maxFiles cap (${opts.maxFiles})`, context: {} });
                    return;
                }
                signal?.throwIfAborted();
                const full = node_path_1.default.join(dir, entry.name);
                const rel = node_path_1.default.relative(rootPath, full).replace(/\\/g, '/');
                const isExcl = opts.excludes.some((p) => (0, minimatch_1.minimatch)(rel, p, { dot: true }));
                if (isExcl)
                    continue;
                const isIncl = opts.includes.length === 0 || opts.includes.some((p) => (0, minimatch_1.minimatch)(rel, p, { dot: true }));
                if (entry.isDirectory()) {
                    await walk(full, depth + 1);
                }
                else if (entry.isFile() && isIncl) {
                    const ext = node_path_1.default.extname(entry.name).toLowerCase();
                    if (!SOURCE_EXTS.has(ext))
                        continue;
                    try {
                        const stat = await promises_1.default.stat(full);
                        if (stat.size > opts.maxFileSize) {
                            warnings.push({ code: 'FILE_TOO_LARGE', message: `${full} (${stat.size} bytes)`, context: { file: full } });
                            continue;
                        }
                    }
                    catch {
                        continue;
                    }
                    results.push(full);
                }
            }
        };
        await walk(rootPath, 0);
        return results;
    }
    async extractCallGraph(analyses, signal) {
        const allEdges = [];
        const grouped = new Map();
        for (const a of analyses) {
            const ext = a.filePath.split('.').pop()?.toLowerCase() ?? '';
            const analyzer = this.registry.dispatchByExtension(ext);
            if (!analyzer)
                continue;
            const key = analyzer.supportedLanguages[0] ?? 'unknown';
            if (!grouped.has(key))
                grouped.set(key, []);
            grouped.get(key).push(a);
        }
        for (const [, group] of grouped) {
            signal?.throwIfAborted();
            const analyzer = this.registry.dispatchByExtension(group[0].filePath.split('.').pop()?.toLowerCase() ?? '');
            if (!analyzer)
                continue;
            const edges = await analyzer.extractCallGraph(group, signal);
            allEdges.push(...edges);
        }
        return allEdges;
    }
    emitProgress(phase, done, total, sessionId) {
        this.eventBus.publish(sessionId, {
            taskId: sessionId,
            type: 'codebase-analysis-progress',
            message: `${phase}: ${done}/${total}`,
            payload: { phase, filesProcessed: done, totalFiles: total },
        }).catch(() => { });
    }
    emitComplete(sessionId, totalFiles) {
        this.eventBus.publish(sessionId, {
            taskId: sessionId,
            type: 'codebase-analysis-complete',
            message: `Analysis complete (${totalFiles} files)`,
            payload: { totalFiles },
        }).catch(() => { });
    }
}
exports.CodebaseAnalyzer = CodebaseAnalyzer;
// ─── Helpers ──────────────────────────────────────────────────────────────────
function uniqueLanguages(analyses) {
    return Array.from(new Set(analyses.map((a) => a.language)));
}
function classifyPatternCategory(kind) {
    const structural = ['monorepo', 'layered-architecture', 'hexagonal-architecture', 'cqrs'];
    const behavioral = ['observer-event-driven', 'pipeline-middleware', 'strategy'];
    const creational = ['factory', 'singleton'];
    const integration = ['repository', 'dependency-injection'];
    const infra = ['service-layer'];
    if (structural.includes(kind))
        return 'structural';
    if (behavioral.includes(kind))
        return 'behavioral';
    if (creational.includes(kind))
        return 'creational';
    if (integration.includes(kind))
        return 'integration';
    if (infra.includes(kind))
        return 'infrastructure';
    return 'structural';
}
function mapVersionSource(src) {
    if (src.startsWith('lockfile'))
        return 'lockfile';
    if (src === 'manifest')
        return 'manifest';
    return 'unknown';
}
function mapLicenseSource(src) {
    if (src === 'lockfile' || src === 'node_modules')
        return src;
    return 'unresolved';
}
function buildModuleBoundaries(rawModules, analyses, symbols) {
    return rawModules.map((m) => {
        const hash = node_crypto_1.default.createHash('sha256').update(m.rootPath).digest('hex').slice(0, 6);
        const pkgFiles = analyses.filter((a) => a.filePath.startsWith(m.rootPath));
        const publicApi = symbols.filter((s) => s.filePath.startsWith(m.rootPath) && s.visibility === 'public');
        return {
            name: m.name,
            rootPath: m.rootPath,
            moduleHash: hash,
            entryPoints: m.entryPoints,
            publicApi,
            internalSymbols: [],
            dependencies: [],
            description: m.description || undefined,
            purposeClass: m.purpose === 'unknown' ? undefined : m.purpose,
        };
    });
}
function detectLanguage(filePath) {
    const ext = node_path_1.default.extname(filePath).toLowerCase();
    switch (ext) {
        case '.ts':
        case '.tsx': return 'typescript';
        case '.js':
        case '.jsx':
        case '.mjs':
        case '.cjs': return 'javascript';
        case '.py': return 'python';
        case '.go': return 'go';
        case '.rs': return 'rust';
        case '.java': return 'java';
        default: return 'unknown';
    }
}
function classifyFilesByExtension(files) {
    const result = {};
    for (const f of files) {
        const lang = detectLanguage(f);
        if (!result[lang])
            result[lang] = [];
        result[lang].push(f);
    }
    return result;
}
//# sourceMappingURL=CodebaseAnalyzer.js.map