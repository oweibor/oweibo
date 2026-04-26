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

import fs from 'node:fs';
import path from 'node:path';
import type {
  ILLMClient,
  IVectorSearch,
  IDocTemplate,
  CodebaseKnowledge,
  AnalysisWarning,
  DocCategory,
  DegradationLevel,
  CodeLanguage,
} from '@oweibo/core-contracts';
import { NoopVectorSearch } from '@oweibo/core-contracts';
import type { TaskEventBus } from '../ingestion/TaskEventBus.js';
import type { ILogger } from './analysis/validateGlobPatterns.js';
import type { AnalysisOptions } from './analysis/CodebaseAnalyzer.js';
import { CodebaseAnalyzer } from './analysis/CodebaseAnalyzer.js';
import { LanguageAnalyzerRegistry } from './analysis/LanguageAnalyzerRegistry.js';
import { PatternDetector } from './analysis/PatternDetector.js';
import { ArchitectureInferrer } from './analysis/ArchitectureInferrer.js';
import { DependencyMapper } from './analysis/DependencyMapper.js';
import { DocAnalyzerCache } from './analysis/DocAnalyzerCache.js';
import { SemanticAnnotator, RepoMapBuilder } from './analysis/SemanticAnnotator.js';
import { TypeScriptAnalyzer } from './analysis/analyzers/TypeScriptAnalyzer.js';
import { PythonAnalyzer } from './analysis/analyzers/PythonAnalyzer.js';
import { GenericAnalyzer } from './analysis/analyzers/GenericAnalyzer.js';
import { DocGeneratorOrchestrator } from './rendering/DocGeneratorOrchestrator.js';
import type { OrchestratorOptions } from './rendering/DocGeneratorOrchestrator.js';
import { PromptBudgetEnforcerAdapter } from './adapters/PromptBudgetEnforcerAdapter.js';
import type { PromptBudgetEnforcer } from './adapters/PromptBudgetEnforcerAdapter.js';
import { buildAllTemplates } from './rendering/templates/index.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface DocGenJob {
  readonly tenantId:       string;
  readonly sessionId:      string;
  readonly rootPath:       string;
  readonly outputDir?:     string;
  readonly options?:       Partial<AnalysisOptions>;
  readonly idempotencyKey?: string;
}

export interface DryRunReport {
  readonly filesDiscovered:        number;
  readonly byLanguage:             Record<CodeLanguage, number>;
  readonly templatesApplicable:    Array<{ category: DocCategory; degradationLevel: DegradationLevel; reason?: string }>;
  readonly requiredCapabilities:   Array<{ capability: string; available: boolean; impact: string }>;
  readonly estimatedLLMTokens:     number;
  readonly estimatedCostUSD?:      number;
}

export interface PipelineResult {
  readonly sessionId:      string;
  readonly writtenFiles:   readonly string[];
  readonly warnings:       readonly AnalysisWarning[];
  readonly knowledge?:     CodebaseKnowledge;
  readonly dryRunReport?:  DryRunReport;
  readonly durationMs:     number;
  /** Actual tokens consumed across both analysis and rendering phases (CRIT-4 / C14). */
  readonly tokensSpent?:   number;
}

export interface DocGeneratorPipelineOptions {
  readonly llm:          ILLMClient;
  readonly eventBus:     TaskEventBus;
  readonly logger:       ILogger;
  readonly vectorSearch?: IVectorSearch;
  readonly globalTokenBudget?: number;
  readonly dotOweiboDir?: string;
  /** Optional infrastructure enforcer for event-bus fallback token accounting (B1). */
  readonly enforcer?:    PromptBudgetEnforcer;
}

// ── DocGeneratorPipeline ──────────────────────────────────────────────────────

export class DocGeneratorPipeline {
  private readonly registry:   LanguageAnalyzerRegistry;
  private readonly archInfer:  ArchitectureInferrer;
  private readonly depMapper:  DependencyMapper;

  constructor(private readonly opts: DocGeneratorPipelineOptions) {
    const registry = new LanguageAnalyzerRegistry();
    registry
      .register(new TypeScriptAnalyzer())
      .register(new PythonAnalyzer())
      .setFallback(new GenericAnalyzer());
    this.registry  = registry;
    this.archInfer = new ArchitectureInferrer(opts.logger);
    this.depMapper = new DependencyMapper(opts.logger);
  }

  async run(job: DocGenJob, signal?: AbortSignal): Promise<PipelineResult> {
    const startMs = Date.now();
    const { tenantId, sessionId, rootPath } = job;
    const outputDir = job.outputDir ?? path.join(rootPath, 'docs');
    const dryRun    = job.options?.dryRun ?? false;

    const controller = new AbortController();
    const combined   = combineSignals(controller.signal, signal);

    await this.opts.eventBus.publish(sessionId, {
      taskId:  sessionId,
      type:    'codebase-analysis-started',
      message: `Starting doc generation for ${path.basename(rootPath)}`,
      payload: { tenantId, rootPath, dryRun },
    });

    try {
      // ── Build analysis components ─────────────────────────────────────────────
      const dotOweiboDir = this.opts.dotOweiboDir ?? path.join(rootPath, '.oweibo');
      const docCache     = await DocAnalyzerCache.create(dotOweiboDir, this.opts.logger);
      const vectorSearch = this.opts.vectorSearch ?? new NoopVectorSearch();

      // One shared budget adapter across analysis + rendering (CRIT-4 / B1).
      // Passing opts.enforcer enables event-bus fallback accounting; passing undefined
      // is valid (tests and embedded callers that have no infrastructure enforcer).
      const budget = new PromptBudgetEnforcerAdapter(
        this.opts.enforcer,
        this.opts.globalTokenBudget ?? 80_000,
        {},
        this.opts.logger,
      );

      const semanticAnnotator = new SemanticAnnotator(
        this.opts.llm,
        budget,
        this.opts.eventBus,
        this.opts.logger,
        vectorSearch,
        new RepoMapBuilder(),
      );

      const analyzer = new CodebaseAnalyzer(
        this.registry,
        new PatternDetector(),
        this.archInfer,
        semanticAnnotator,
        this.depMapper,
        docCache,
        this.opts.llm,
        this.opts.logger,
        this.opts.eventBus,
        vectorSearch,
      );

      const analysisOpts: AnalysisOptions = {
        tenantId,
        sessionId,
        skipLLM:        dryRun,
        redactAuthors:  job.options?.redactAuthors ?? true,
        ...job.options,
      };

      // ── Phase 1–6: Analysis ───────────────────────────────────────────────────
      const knowledge = await analyzer.analyze(rootPath, analysisOpts, combined);

      await this.opts.eventBus.publish(sessionId, {
        taskId:  sessionId,
        type:    'codebase-analysis-complete',
        message: `Analysis complete: ${knowledge.modules.length} modules, ${knowledge.files.length} files`,
        payload: { moduleCount: knowledge.modules.length, fileCount: knowledge.files.length },
      });

      // Templates are built before the dry-run branch so isApplicable() can be called
      // for the dry-run report without a second construction (CRIT-4).
      const templates = buildAllTemplates(analysisOpts);

      // ── Dry run: return report without rendering ───────────────────────────────
      if (dryRun) {
        const gitAvailable = fs.existsSync(path.join(rootPath, '.git'));
        const report = buildDryRunReport(knowledge, templates, {
          llm:          true,
          gitAvailable,
        });
        return {
          sessionId,
          writtenFiles: [],
          warnings:     knowledge.warnings,
          dryRunReport: report,
          durationMs:   Date.now() - startMs,
          tokensSpent:  0,
        };
      }

      // ── Rendering ─────────────────────────────────────────────────────────────
      await this.opts.eventBus.publish(sessionId, {
        taskId:  sessionId,
        type:    'doc-generation-started',
        message: 'Rendering documentation templates',
        payload: { tenantId },
      });

      const ctx = { llm: this.opts.llm, tokenBudget: budget };

      const orchOpts: OrchestratorOptions = {
        outputDir,
        redactSecrets: true,
      };

      const orchestrator = new DocGeneratorOrchestrator(templates, ctx, orchOpts);
      const result       = await orchestrator.run(knowledge, combined);

      for (const w of result.warnings) {
        await this.opts.eventBus.publish(sessionId, {
          taskId:  sessionId,
          type:    'doc-generation-warning',
          message: w.message,
          payload: { ...w.context, code: w.code },
        });
      }

      await this.opts.eventBus.publish(sessionId, {
        taskId:  sessionId,
        type:    'doc-generation-complete',
        message: `Documentation written: ${result.writtenFiles.length} files`,
        payload: { writtenFiles: result.writtenFiles, tenantId },
      });

      return {
        sessionId,
        writtenFiles: result.writtenFiles,
        warnings:     result.warnings,
        knowledge,
        durationMs:   Date.now() - startMs,
        tokensSpent:  budget.totalSpent,
      };
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        await this.opts.eventBus.publish(sessionId, {
          taskId:  sessionId,
          type:    'doc-generation-warning',
          message: 'Doc generation cancelled',
          payload: { code: 'RUN_CANCELLED', tenantId },
        });
      }
      controller.abort();
      throw err;
    }
  }

  cancel(controller: AbortController): void {
    controller.abort();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const ctrl = new AbortController();
  for (const sig of signals) {
    if (!sig) continue;
    if (sig.aborted) { ctrl.abort(); return ctrl.signal; }
    sig.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}

function buildDryRunReport(
  knowledge:  CodebaseKnowledge,
  templates:  readonly IDocTemplate[],
  caps:       { llm: boolean; gitAvailable: boolean },
): DryRunReport {
  const byLanguage: Record<string, number> = {};
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
    filesDiscovered:   knowledge.files.length,
    byLanguage:        byLanguage as Record<CodeLanguage, number>,
    templatesApplicable,
    requiredCapabilities: [
      {
        capability: 'llm',
        available:  caps.llm,
        impact:     'Semantic annotations and LLM-powered sections skipped without LLM',
      },
      {
        capability: 'git',
        available:  caps.gitAvailable,
        impact:     'Changelog and inferred-ADR templates degrade to skeleton without git history',
      },
    ],
    estimatedLLMTokens,
    estimatedCostUSD: (estimatedLLMTokens / 1_000_000) * 15,
  };
}
