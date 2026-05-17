import type { IDocTemplate, RenderedDocument, AnalysisWarning } from '@oweibo/core-contracts';
import type { CodebaseKnowledge } from '@oweibo/core-contracts';
import type { DocTemplateContext } from '@oweibo/core-contracts';
export interface OrchestratorOptions {
    readonly outputDir: string;
    readonly maxConcurrency?: number;
    readonly redactSecrets?: boolean;
    readonly skipExport?: boolean;
}
export interface OrchestratorResult {
    readonly rendered: readonly RenderedDocument[];
    readonly writtenFiles: readonly string[];
    readonly warnings: readonly AnalysisWarning[];
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
export declare class DocGeneratorOrchestrator {
    private readonly templates;
    private readonly ctx;
    private readonly options;
    private readonly crossRefLinker;
    private readonly validator;
    private readonly exporter;
    private readonly diagrams;
    constructor(templates: readonly IDocTemplate[], ctx: DocTemplateContext, options: OrchestratorOptions);
    run(knowledge: CodebaseKnowledge, signal?: AbortSignal): Promise<OrchestratorResult>;
}
//# sourceMappingURL=DocGeneratorOrchestrator.d.ts.map