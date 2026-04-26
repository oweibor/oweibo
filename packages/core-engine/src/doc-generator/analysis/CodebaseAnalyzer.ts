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

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { minimatch } from 'minimatch';
import type {
  ILLMClient,
  IVectorSearch,
  NoopVectorSearch,
  CodebaseKnowledge,
  CodeLanguage,
  FileAnalysis,
  SymbolInfo,
  EnrichedCallEdge,
  ModuleBoundary,
  ArchitecturalPattern,
  ExternalDependency,
  AnalysisWarning,
  AnalysisWarningCode,
} from '@oweibo/core-contracts';
import type { TaskEventBus } from '../../ingestion/TaskEventBus.js';
import { LanguageAnalyzerRegistry } from './LanguageAnalyzerRegistry.js';
import { PatternDetector } from './PatternDetector.js';
import { ArchitectureInferrer } from './ArchitectureInferrer.js';
import { DependencyMapper } from './DependencyMapper.js';
import { DocAnalyzerCache } from './DocAnalyzerCache.js';
import { SemanticAnnotator } from './SemanticAnnotator.js';
import { validateGlobPatterns } from './validateGlobPatterns.js';
import type { ILogger } from './validateGlobPatterns.js';

// ─── AnalysisOptions ──────────────────────────────────────────────────────────

export interface AnalysisOptions {
  readonly excludePatterns?: readonly string[];
  readonly includePatterns?: readonly string[];
  readonly selfMode?:        boolean;
  readonly maxFiles?:        number;
  readonly maxFileSize?:     number;
  readonly maxDepth?:        number;
  readonly skipLLM?:         boolean;
  readonly dryRun?:          boolean;
  readonly redactAuthors?:   boolean;
  readonly tenantId:         string;
  readonly sessionId:        string;
}

const DEFAULT_EXCLUDES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.git/**',
  '**/.oweibo/**',
  '**/doc-generator/**',
];
const DEFAULT_MAX_FILES    = 5_000;
const DEFAULT_MAX_FILE_SIZE = 1_048_576; // 1 MB
const DEFAULT_MAX_DEPTH    = 10;

// ─── CodebaseAnalyzer ─────────────────────────────────────────────────────────

export class CodebaseAnalyzer {
  constructor(
    private readonly registry:          LanguageAnalyzerRegistry,
    private readonly patternDetector:   PatternDetector,
    private readonly archInferrer:      ArchitectureInferrer,
    private readonly semanticAnnotator: SemanticAnnotator,
    private readonly depMapper:         DependencyMapper,
    private readonly docCache:          DocAnalyzerCache,
    private readonly llm:               ILLMClient,
    private readonly logger:            ILogger,
    private readonly eventBus:          TaskEventBus,
    private readonly vectorSearch:      IVectorSearch,
  ) {}

  async analyze(
    rootPath: string,
    options?: AnalysisOptions,
    signal?:  AbortSignal,
  ): Promise<CodebaseKnowledge> {
    const startMs = Date.now();
    const warnings: AnalysisWarning[] = [];
    const opts = options ?? { tenantId: 'default', sessionId: 'default' };

    // ── Phase 1: Discovery ────────────────────────────────────────────────────
    this.emitProgress('discovery', 0, 0, opts.sessionId);
    signal?.throwIfAborted();

    const validExcludes = validateGlobPatterns(
      opts.selfMode
        ? ['**/doc-generator/**']
        : (opts.excludePatterns ?? DEFAULT_EXCLUDES),
      this.logger,
    );
    const validIncludes = validateGlobPatterns(opts.includePatterns ?? [], this.logger);

    const allFiles = await this.walkFs(rootPath, {
      excludes:    validExcludes,
      includes:    validIncludes,
      maxFiles:    opts.maxFiles ?? DEFAULT_MAX_FILES,
      maxFileSize: opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE,
      maxDepth:    opts.maxDepth ?? DEFAULT_MAX_DEPTH,
    }, warnings, signal);

    // ── Dry-run early exit (C16, HIGH-2) ─────────────────────────────────────
    // Short-circuit after phase 1 only: return a skeleton knowledge carrying the
    // file list so DocGeneratorPipeline can build a DryRunReport without running
    // AST extraction, LLM calls, or any file writes.
    if (opts.dryRun) {
      const byLang = classifyFilesByExtension(allFiles);
      const durationMs = Date.now() - startMs;
      return {
        projectName:             path.basename(rootPath),
        rootPath,
        analyzedAt:              new Date().toISOString(),
        analysisDurationMs:      durationMs,
        languages:               Object.keys(byLang) as CodeLanguage[],
        totalFiles:              allFiles.length,
        totalLines:              0,
        files:                   allFiles.map((f) => ({
          filePath:     f,
          language:     detectLanguage(f),
          lineCount:    0,
          complexity:   1,
          exports:      [],
          imports:      [],
          dependencies: [],
        })),
        symbols:                 [],
        callGraph:               [],
        modules:                 [],
        patterns:                [],
        dataFlows:               [],
        inferredADRs:            [],
        externalDependencies:    [],
        internalDependencyGraph: [],
        projectSummary:          '',
        gettingStarted:          undefined,
        conventions:             [],
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
    const architecturalPatterns: ArchitecturalPattern[] = detectedPatterns
      .filter((p) => p.confidence > 0)
      .map((p) => ({
        name:        p.kind,
        confidence:  p.confidence,
        evidence:    p.evidence,
        description: p.description,
        category:    classifyPatternCategory(p.kind),
      }));

    // ── Phase 5: Dependency mapping ──────────────────────────────────────────
    this.emitProgress('dependency-mapping', analyses.length, allFiles.length, opts.sessionId);
    signal?.throwIfAborted();

    const rawDeps = await this.depMapper.map(rootPath, signal);
    const externalDeps: ExternalDependency[] = rawDeps.map((d) => ({
      name:          d.name,
      version:       d.version ?? 'unknown',
      versionSource: mapVersionSource(d.versionSource),
      purpose:       d.purpose || undefined,
      isDev:         d.isDev,
      license:       d.license,
      licenseSource: mapLicenseSource(d.licenseSource),
    }));

    // Aggregate all symbols and call graph
    const allSymbols:    readonly SymbolInfo[]       = analyses.flatMap((a) => a.exports);
    const callEdges:     readonly EnrichedCallEdge[] = await this.extractCallGraph(analyses, signal);
    const modules:       readonly ModuleBoundary[]   = buildModuleBoundaries(rawModules, analyses, allSymbols);

    // Build partial knowledge for semantic phase
    const partialKnowledge = {
      projectName:          path.basename(rootPath),
      rootPath,
      analyzedAt:           new Date().toISOString(),
      analysisDurationMs:   0,
      languages:            uniqueLanguages(analyses),
      totalFiles:           analyses.length,
      totalLines:           analyses.reduce((n, a) => n + a.lineCount, 0),
      files:                analyses,
      symbols:              allSymbols,
      callGraph:            callEdges,
      modules,
      patterns:             architecturalPatterns,
      dataFlows:            [],
      inferredADRs:         [],
      externalDependencies: externalDeps,
      internalDependencyGraph: [],
      warnings:             [...warnings],
    };

    // ── Phase 6: Semantic enrichment ─────────────────────────────────────────
    this.emitProgress('semantic-enrichment', analyses.length, allFiles.length, opts.sessionId);
    signal?.throwIfAborted();

    const semantic = await this.semanticAnnotator.annotate(partialKnowledge, signal);
    warnings.push(...semantic.warnings);

    const durationMs = Date.now() - startMs;

    const knowledge: CodebaseKnowledge = {
      ...partialKnowledge,
      analysisDurationMs: durationMs,
      projectSummary:     semantic.projectSummary,
      gettingStarted:     semantic.gettingStarted || undefined,
      conventions:        semantic.conventions,
      inferredADRs:       semantic.inferredADRs,
      warnings,
    };

    this.emitComplete(opts.sessionId, analyses.length);
    return knowledge;
  }

  async incrementalAnalyze(
    rootPath:     string,
    previous:     CodebaseKnowledge,
    changedFiles: readonly string[],
    signal?:      AbortSignal,
  ): Promise<CodebaseKnowledge> {
    // Re-analyze only changed files; merge with previous for unchanged
    const unchanged = previous.files.filter(
      (f) => !changedFiles.includes(f.filePath),
    );
    const { analyses: changed } = await this.registry.analyzeDirectory(rootPath, changedFiles, signal);
    const merged = [...unchanged, ...changed];
    const pseudoKnowledge: CodebaseKnowledge = {
      ...previous,
      files:      merged,
      symbols:    merged.flatMap((a) => a.exports),
      totalFiles: merged.length,
      totalLines: merged.reduce((n, a) => n + a.lineCount, 0),
      analyzedAt: new Date().toISOString(),
    };
    return pseudoKnowledge;
  }

  // ── Internal helpers ─────────────────────────────────────────────────────────

  private async walkFs(
    rootPath: string,
    opts: {
      excludes:    readonly string[];
      includes:    readonly string[];
      maxFiles:    number;
      maxFileSize: number;
      maxDepth:    number;
    },
    warnings: AnalysisWarning[],
    signal?:  AbortSignal,
  ): Promise<string[]> {
    const results: string[] = [];
    const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.py', '.go', '.rs', '.java']);

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > opts.maxDepth) {
        warnings.push({ code: 'MAX_DEPTH_EXCEEDED', message: `Depth ${depth} exceeds max ${opts.maxDepth}`, context: { dir } });
        return;
      }
      if (results.length >= opts.maxFiles) return;
      signal?.throwIfAborted();

      let entries: { name: string; isFile(): boolean; isDirectory(): boolean }[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf-8' });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (results.length >= opts.maxFiles) {
          warnings.push({ code: 'MAX_FILES_EXCEEDED', message: `Hit maxFiles cap (${opts.maxFiles})`, context: {} });
          return;
        }
        signal?.throwIfAborted();

        const full    = path.join(dir, entry.name);
        const rel     = path.relative(rootPath, full).replace(/\\/g, '/');
        const isExcl  = opts.excludes.some((p) => minimatch(rel, p, { dot: true }));
        if (isExcl) continue;
        const isIncl  = opts.includes.length === 0 || opts.includes.some((p) => minimatch(rel, p, { dot: true }));

        if (entry.isDirectory()) {
          await walk(full, depth + 1);
        } else if (entry.isFile() && isIncl) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!SOURCE_EXTS.has(ext)) continue;
          try {
            const stat = await fs.stat(full);
            if (stat.size > opts.maxFileSize) {
              warnings.push({ code: 'FILE_TOO_LARGE', message: `${full} (${stat.size} bytes)`, context: { file: full } });
              continue;
            }
          } catch { continue; }
          results.push(full);
        }
      }
    };

    await walk(rootPath, 0);
    return results;
  }

  private async extractCallGraph(
    analyses: readonly FileAnalysis[],
    signal?:  AbortSignal,
  ): Promise<readonly EnrichedCallEdge[]> {
    const allEdges: EnrichedCallEdge[] = [];
    const grouped = new Map<string, FileAnalysis[]>();
    for (const a of analyses) {
      const ext = a.filePath.split('.').pop()?.toLowerCase() ?? '';
      const analyzer = this.registry.dispatchByExtension(ext);
      if (!analyzer) continue;
      const key = analyzer.supportedLanguages[0] ?? 'unknown';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(a);
    }
    for (const [, group] of grouped) {
      signal?.throwIfAborted();
      const analyzer = this.registry.dispatchByExtension(
        group[0]!.filePath.split('.').pop()?.toLowerCase() ?? '',
      );
      if (!analyzer) continue;
      const edges = await analyzer.extractCallGraph(group, signal);
      allEdges.push(...edges);
    }
    return allEdges;
  }

  private emitProgress(phase: string, done: number, total: number, sessionId: string): void {
    this.eventBus.publish(sessionId, {
      taskId:  sessionId,
      type:    'codebase-analysis-progress',
      message: `${phase}: ${done}/${total}`,
      payload: { phase, filesProcessed: done, totalFiles: total },
    }).catch(() => { /* best-effort */ });
  }

  private emitComplete(sessionId: string, totalFiles: number): void {
    this.eventBus.publish(sessionId, {
      taskId:  sessionId,
      type:    'codebase-analysis-complete',
      message: `Analysis complete (${totalFiles} files)`,
      payload: { totalFiles },
    }).catch(() => { /* best-effort */ });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uniqueLanguages(analyses: readonly FileAnalysis[]): readonly CodeLanguage[] {
  return Array.from(new Set(analyses.map((a) => a.language)));
}

function classifyPatternCategory(
  kind: string,
): 'structural' | 'behavioral' | 'creational' | 'integration' | 'infrastructure' {
  const structural  = ['monorepo', 'layered-architecture', 'hexagonal-architecture', 'cqrs'];
  const behavioral  = ['observer-event-driven', 'pipeline-middleware', 'strategy'];
  const creational  = ['factory', 'singleton'];
  const integration = ['repository', 'dependency-injection'];
  const infra       = ['service-layer'];
  if (structural.includes(kind))  return 'structural';
  if (behavioral.includes(kind))  return 'behavioral';
  if (creational.includes(kind))  return 'creational';
  if (integration.includes(kind)) return 'integration';
  if (infra.includes(kind))       return 'infrastructure';
  return 'structural';
}

function mapVersionSource(src: string): 'lockfile' | 'manifest' | 'unknown' {
  if (src.startsWith('lockfile')) return 'lockfile';
  if (src === 'manifest') return 'manifest';
  return 'unknown';
}

function mapLicenseSource(src: string): ExternalDependency['licenseSource'] {
  if (src === 'lockfile' || src === 'node_modules') return src;
  return 'unresolved';
}

function buildModuleBoundaries(
  rawModules: Awaited<ReturnType<import('./ArchitectureInferrer.js').ArchitectureInferrer['infer']>>,
  analyses:   readonly FileAnalysis[],
  symbols:    readonly SymbolInfo[],
): readonly ModuleBoundary[] {
  return rawModules.map((m) => {
    const hash = crypto.createHash('sha256').update(m.rootPath).digest('hex').slice(0, 6);
    const pkgFiles = analyses.filter((a) => a.filePath.startsWith(m.rootPath));
    const publicApi = symbols.filter((s) =>
      s.filePath.startsWith(m.rootPath) && s.visibility === 'public',
    );
    return {
      name:             m.name,
      rootPath:         m.rootPath,
      moduleHash:       hash,
      entryPoints:      m.entryPoints,
      publicApi,
      internalSymbols:  [],
      dependencies:     [],
      description:      m.description || undefined,
      purposeClass:     m.purpose === 'unknown' ? undefined : m.purpose,
    };
  });
}
