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
import type { ILLMClient, IVectorSearch, CodebaseKnowledge, AnalysisWarning, DocCategory, DegradationLevel, CodeLanguage } from '@oweibo/core-contracts';
import type { TaskEventBus } from '../ingestion/TaskEventBus.js';
import type { ILogger } from './analysis/validateGlobPatterns.js';
import type { AnalysisOptions } from './analysis/CodebaseAnalyzer.js';
import type { PromptBudgetEnforcer } from './adapters/PromptBudgetEnforcerAdapter.js';
export interface DocGenJob {
    readonly tenantId: string;
    readonly sessionId: string;
    readonly rootPath: string;
    readonly outputDir?: string;
    readonly options?: Partial<AnalysisOptions>;
    readonly idempotencyKey?: string;
    /** Internal retry counter for per-tenant concurrency back-pressure (not persisted). */
    readonly _tenantRetries?: number;
}
export interface DryRunReport {
    readonly filesDiscovered: number;
    readonly byLanguage: Record<CodeLanguage, number>;
    readonly templatesApplicable: Array<{
        category: DocCategory;
        degradationLevel: DegradationLevel;
        reason?: string;
    }>;
    readonly requiredCapabilities: Array<{
        capability: string;
        available: boolean;
        impact: string;
    }>;
    readonly estimatedLLMTokens: number;
    readonly estimatedCostUSD?: number;
}
export interface PipelineResult {
    readonly sessionId: string;
    readonly writtenFiles: readonly string[];
    readonly warnings: readonly AnalysisWarning[];
    readonly knowledge?: CodebaseKnowledge;
    readonly dryRunReport?: DryRunReport;
    readonly durationMs: number;
    /** Actual tokens consumed across both analysis and rendering phases (CRIT-4 / C14). */
    readonly tokensSpent?: number;
}
export interface DocGeneratorPipelineOptions {
    readonly llm: ILLMClient;
    readonly eventBus: TaskEventBus;
    readonly logger: ILogger;
    readonly vectorSearch?: IVectorSearch;
    readonly globalTokenBudget?: number;
    readonly dotOweiboDir?: string;
    /** Optional infrastructure enforcer for event-bus fallback token accounting (B1). */
    readonly enforcer?: PromptBudgetEnforcer;
}
export declare class DocGeneratorPipeline {
    private readonly opts;
    private readonly registry;
    private readonly archInfer;
    private readonly depMapper;
    constructor(opts: DocGeneratorPipelineOptions);
    run(job: DocGenJob, signal?: AbortSignal): Promise<PipelineResult>;
    cancel(controller: AbortController): void;
}
//# sourceMappingURL=DocGeneratorPipeline.d.ts.map