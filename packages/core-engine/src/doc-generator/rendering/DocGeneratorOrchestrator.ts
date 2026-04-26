import type { IDocTemplate, RenderedDocument, AnalysisWarning } from '@oweibo/core-contracts';
import type { CodebaseKnowledge } from '@oweibo/core-contracts';
import type { DocTemplateContext } from '@oweibo/core-contracts';
import { CrossRefLinker } from './CrossRefLinker.js';
import { DocValidator } from './DocValidator.js';
import { DocExporter, type ExportOptions } from './DocExporter.js';
import { DiagramGenerator } from './DiagramGenerator.js';

const DEFAULT_CONCURRENCY = 4;

export interface OrchestratorOptions {
  readonly outputDir:     string;
  readonly maxConcurrency?: number;
  readonly redactSecrets?: boolean;
  readonly skipExport?:   boolean;
}

export interface OrchestratorResult {
  readonly rendered:     readonly RenderedDocument[];
  readonly writtenFiles: readonly string[];
  readonly warnings:     readonly AnalysisWarning[];
}

/**
 * DocGeneratorOrchestrator — drives the rendering pipeline.
 *
 * Pipeline:
 *   1. Template selection (isApplicable)
 *   2. Parallel rendering (max concurrency: 4)
 *   3. Cross-reference linking
 *   4. Validation
 *   5. Export to filesystem
 */
export class DocGeneratorOrchestrator {
  private readonly crossRefLinker = new CrossRefLinker();
  private readonly validator      = new DocValidator();
  private readonly exporter       = new DocExporter();
  private readonly diagrams       = new DiagramGenerator();

  constructor(
    private readonly templates: readonly IDocTemplate[],
    private readonly ctx:       DocTemplateContext,
    private readonly options:   OrchestratorOptions,
  ) {}

  async run(
    knowledge: CodebaseKnowledge,
    signal?:   AbortSignal,
  ): Promise<OrchestratorResult> {
    signal?.throwIfAborted();
    const warnings: AnalysisWarning[] = [];

    // ── 1. Template selection ──────────────────────────────────────────────────
    const applicable = this.templates.filter((t) => {
      const check = t.isApplicable(knowledge);
      if (!check.applicable || check.degradationLevel === 'skipped') {
        warnings.push({
          code:    'TEMPLATE_NOT_APPLICABLE',
          message: `Template ${t.fileName} skipped: ${check.reason ?? check.degradationLevel}`,
          context: { template: t.fileName, level: check.degradationLevel },
        });
        return false;
      }
      return true;
    });

    // ── 2. Parallel rendering ──────────────────────────────────────────────────
    const concurrency = this.options.maxConcurrency ?? DEFAULT_CONCURRENCY;
    const rendered:   RenderedDocument[] = [];

    for (let i = 0; i < applicable.length; i += concurrency) {
      signal?.throwIfAborted();
      const batch = applicable.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map((t) => t.render(knowledge, this.ctx, signal)),
      );
      for (let j = 0; j < results.length; j++) {
        const res = results[j]!;
        if (res.status === 'fulfilled') {
          rendered.push(res.value);
        } else {
          warnings.push({
            code:    'TEMPLATE_DEGRADED',
            message: `Template ${batch[j]!.fileName} failed: ${(res.reason as Error).message}`,
            context: { template: batch[j]!.fileName },
          });
        }
      }
    }

    signal?.throwIfAborted();

    // ── 3. Cross-reference linking ─────────────────────────────────────────────
    const linked = this.crossRefLinker.link(rendered, knowledge);

    // ── 4. Validation ─────────────────────────────────────────────────────────
    const validation = this.validator.validate(linked);
    warnings.push(...validation.warnings);

    const finalDocs = this.options.redactSecrets
      ? linked.map((d) => this.validator.redact(d))
      : linked;

    // ── 5. Export ─────────────────────────────────────────────────────────────
    let writtenFiles: readonly string[] = [];
    if (!this.options.skipExport) {
      const exportResult = await this.exporter.export(finalDocs, {
        outputDir:   this.options.outputDir,
        strictPaths: true,
      });
      writtenFiles = exportResult.writtenFiles;
      warnings.push(...exportResult.warnings);
    }

    return { rendered: finalDocs, writtenFiles, warnings };
  }
}
