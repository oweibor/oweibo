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
import type { ILLMClient, IVectorSearch, CodebaseKnowledge } from '@oweibo/core-contracts';
import type { TaskEventBus } from '../../ingestion/TaskEventBus.js';
import { LanguageAnalyzerRegistry } from './LanguageAnalyzerRegistry.js';
import { PatternDetector } from './PatternDetector.js';
import { ArchitectureInferrer } from './ArchitectureInferrer.js';
import { DependencyMapper } from './DependencyMapper.js';
import { DocAnalyzerCache } from './DocAnalyzerCache.js';
import { SemanticAnnotator } from './SemanticAnnotator.js';
import type { ILogger } from './validateGlobPatterns.js';
export interface AnalysisOptions {
    readonly excludePatterns?: readonly string[];
    readonly includePatterns?: readonly string[];
    readonly selfMode?: boolean;
    readonly maxFiles?: number;
    readonly maxFileSize?: number;
    readonly maxDepth?: number;
    readonly skipLLM?: boolean;
    readonly dryRun?: boolean;
    readonly redactAuthors?: boolean;
    readonly tenantId: string;
    readonly sessionId: string;
}
export declare class CodebaseAnalyzer {
    private readonly registry;
    private readonly patternDetector;
    private readonly archInferrer;
    private readonly semanticAnnotator;
    private readonly depMapper;
    private readonly docCache;
    private readonly llm;
    private readonly logger;
    private readonly eventBus;
    private readonly vectorSearch;
    constructor(registry: LanguageAnalyzerRegistry, patternDetector: PatternDetector, archInferrer: ArchitectureInferrer, semanticAnnotator: SemanticAnnotator, depMapper: DependencyMapper, docCache: DocAnalyzerCache, llm: ILLMClient, logger: ILogger, eventBus: TaskEventBus, vectorSearch: IVectorSearch);
    analyze(rootPath: string, options?: AnalysisOptions, signal?: AbortSignal): Promise<CodebaseKnowledge>;
    incrementalAnalyze(rootPath: string, previous: CodebaseKnowledge, changedFiles: readonly string[], signal?: AbortSignal): Promise<CodebaseKnowledge>;
    private walkFs;
    private extractCallGraph;
    private emitProgress;
    private emitComplete;
}
//# sourceMappingURL=CodebaseAnalyzer.d.ts.map