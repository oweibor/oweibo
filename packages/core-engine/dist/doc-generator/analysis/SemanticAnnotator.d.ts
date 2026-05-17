import type { ILLMClient } from '@oweibo/core-contracts';
import type { ITokenBudget } from '@oweibo/core-contracts';
import type { IVectorSearch } from '@oweibo/core-contracts';
import type { CodebaseKnowledge, Convention, InferredADR, AnalysisWarning } from '@oweibo/core-contracts';
import type { TaskEventBus } from '../../ingestion/TaskEventBus.js';
import type { ILogger } from './validateGlobPatterns.js';
/** Builds a compact token-limited summary of the repo for LLM context. */
export declare class RepoMapBuilder {
    build(knowledge: Partial<CodebaseKnowledge>, maxTokens: number): string;
}
export interface SemanticAnnotatorOptions {
    readonly skipLLM?: boolean;
}
export declare class SemanticAnnotator {
    private readonly llm;
    private readonly tokenBudget;
    private readonly eventBus;
    private readonly logger;
    private readonly vectorSearch;
    private readonly repoMap;
    private readonly options;
    constructor(llm: ILLMClient, tokenBudget: ITokenBudget, eventBus: TaskEventBus, logger: ILogger, vectorSearch: IVectorSearch, repoMap: RepoMapBuilder, options?: SemanticAnnotatorOptions);
    /**
     * Enriches a partial CodebaseKnowledge with LLM-generated annotations.
     * On any LLM failure (BudgetExhaustedError, timeout), emits a warning and
     * returns the structural-only knowledge with empty semantic fields.
     *
     * Never throws — docs always ship, degraded quality flagged in warnings.
     */
    annotate(knowledge: Omit<CodebaseKnowledge, 'projectSummary' | 'gettingStarted' | 'conventions'>, signal?: AbortSignal): Promise<{
        projectSummary: string;
        gettingStarted: string;
        conventions: readonly Convention[];
        inferredADRs: readonly InferredADR[];
        warnings: readonly AnalysisWarning[];
    }>;
    enrichModuleDescriptions(modules: ReadonlyArray<{
        name: string;
        publicApi: ReadonlyArray<{
            name: string;
            kind: string;
        }>;
    }>, signal?: AbortSignal): Promise<Map<string, string>>;
    enrichDependencyPurposes(packageNames: readonly string[], signal?: AbortSignal): Promise<Map<string, string>>;
    private callLLM;
    private safeCall;
    private classifyLLMError;
}
//# sourceMappingURL=SemanticAnnotator.d.ts.map