import type {
  ILLMClient,
  ILLMGenerateRequest,
} from '@oweibo/core-contracts';
import type { ITokenBudget, BudgetExhaustedError } from '@oweibo/core-contracts';
import type { IVectorSearch } from '@oweibo/core-contracts';
import type { NoopVectorSearch } from '@oweibo/core-contracts';
import type {
  CodebaseKnowledge,
  Convention,
  InferredADR,
  AnalysisWarning,
} from '@oweibo/core-contracts';
import type { TaskEventBus } from '../../ingestion/TaskEventBus.js';
import {
  DOC_GEN_PHASES,
  PHASE_TOKEN_BUDGETS,
  PROJECT_SUMMARY_SYSTEM_PROMPT,
  PROJECT_SUMMARY_USER_PROMPT,
  MODULE_DESC_SYSTEM_PROMPT,
  MODULE_DESC_USER_PROMPT,
  ADR_INFER_SYSTEM_PROMPT,
  ADR_INFER_USER_PROMPT,
  CONVENTIONS_SYSTEM_PROMPT,
  CONVENTIONS_USER_PROMPT,
  DEP_PURPOSE_SYSTEM_PROMPT,
  DEP_PURPOSE_USER_PROMPT,
  GETTING_STARTED_SYSTEM_PROMPT,
  GETTING_STARTED_USER_PROMPT,
} from '../prompts/DocGeneratorPrompts.js';
import type { ILogger } from './validateGlobPatterns.js';

// ─── RepoMapBuilder stub ──────────────────────────────────────────────────────

/** Builds a compact token-limited summary of the repo for LLM context. */
export class RepoMapBuilder {
  build(knowledge: Partial<CodebaseKnowledge>, maxTokens: number): string {
    const lines: string[] = [];
    if (knowledge.projectName) lines.push(`Project: ${knowledge.projectName}`);
    if (knowledge.languages)   lines.push(`Languages: ${knowledge.languages.join(', ')}`);
    if (knowledge.totalFiles)  lines.push(`Files: ${knowledge.totalFiles}`);
    if (knowledge.modules) {
      lines.push(`Modules: ${knowledge.modules.map((m) => m.name).join(', ')}`);
    }
    const joined = lines.join('\n');
    // Rough token estimate: 1 token ≈ 4 chars
    const maxChars = maxTokens * 4;
    return joined.length > maxChars ? joined.slice(0, maxChars) + '\n...(truncated)' : joined;
  }
}

// ─── LLM Circuit Breaker types ────────────────────────────────────────────────

interface LLMCallResult<T> {
  readonly value: T | null;
  readonly warning: AnalysisWarning | null;
}

// ─── SemanticAnnotator ────────────────────────────────────────────────────────

export interface SemanticAnnotatorOptions {
  readonly skipLLM?: boolean;
}

export class SemanticAnnotator {
  constructor(
    private readonly llm:          ILLMClient,
    private readonly tokenBudget:  ITokenBudget,
    private readonly eventBus:     TaskEventBus,
    private readonly logger:       ILogger,
    private readonly vectorSearch: IVectorSearch,
    private readonly repoMap:      RepoMapBuilder,
    private readonly options:      SemanticAnnotatorOptions = {},
  ) {}

  /**
   * Enriches a partial CodebaseKnowledge with LLM-generated annotations.
   * On any LLM failure (BudgetExhaustedError, timeout), emits a warning and
   * returns the structural-only knowledge with empty semantic fields.
   *
   * Never throws — docs always ship, degraded quality flagged in warnings.
   */
  async annotate(
    knowledge: Omit<CodebaseKnowledge, 'projectSummary' | 'gettingStarted' | 'conventions'>,
    signal?:   AbortSignal,
  ): Promise<{
    projectSummary: string;
    gettingStarted: string;
    conventions:    readonly Convention[];
    inferredADRs:   readonly InferredADR[];
    warnings:       readonly AnalysisWarning[];
  }> {
    signal?.throwIfAborted();
    const warnings: AnalysisWarning[] = [];

    if (this.options.skipLLM) {
      return { projectSummary: '', gettingStarted: '', conventions: [], inferredADRs: knowledge.inferredADRs ?? [], warnings };
    }

    const repoCtx = this.repoMap.build(knowledge, 2_000);

    // Project summary
    const summaryResult = await this.safeCall<{ summary: string }>(
      DOC_GEN_PHASES.PROJECT_SUMMARY,
      PHASE_TOKEN_BUDGETS['doc-project-summary'].input,
      () => this.callLLM(PROJECT_SUMMARY_SYSTEM_PROMPT, PROJECT_SUMMARY_USER_PROMPT(repoCtx)),
      signal,
    );
    if (summaryResult.warning) warnings.push(summaryResult.warning);

    signal?.throwIfAborted();

    // Convention detection
    const convResult = await this.safeCall<Convention[]>(
      DOC_GEN_PHASES.CONVENTIONS,
      PHASE_TOKEN_BUDGETS['doc-conventions'].input,
      () => {
        const symbolSample = knowledge.symbols.slice(0, 50).map((s) => `${s.kind} ${s.name}`).join('\n');
        return this.callLLM(CONVENTIONS_SYSTEM_PROMPT, CONVENTIONS_USER_PROMPT(symbolSample));
      },
      signal,
    );
    if (convResult.warning) warnings.push(convResult.warning);

    signal?.throwIfAborted();

    // Getting started
    const gettingStartedResult = await this.safeCall<string>(
      DOC_GEN_PHASES.GETTING_STARTED,
      PHASE_TOKEN_BUDGETS['doc-getting-started'].input,
      () => this.callLLM(GETTING_STARTED_SYSTEM_PROMPT, GETTING_STARTED_USER_PROMPT(repoCtx)),
      signal,
    );
    if (gettingStartedResult.warning) warnings.push(gettingStartedResult.warning);

    signal?.throwIfAborted();

    // ADR inference from detected patterns
    const adrResult = await this.safeCall<InferredADR[]>(
      DOC_GEN_PHASES.ADR_INFER,
      PHASE_TOKEN_BUDGETS['doc-adr-infer'].input,
      () => {
        const evidence = knowledge.patterns
          .map((p) => `Pattern: ${p.name} (confidence ${p.confidence.toFixed(2)})\nDescription: ${p.description}`)
          .join('\n\n');
        return this.callLLM(ADR_INFER_SYSTEM_PROMPT, ADR_INFER_USER_PROMPT(evidence));
      },
      signal,
    );
    if (adrResult.warning) warnings.push(adrResult.warning);

    return {
      projectSummary: summaryResult.value?.summary ?? '',
      gettingStarted: typeof gettingStartedResult.value === 'string' ? gettingStartedResult.value : '',
      conventions:    Array.isArray(convResult.value) ? (convResult.value as Convention[]) : [],
      inferredADRs:   Array.isArray(adrResult.value) ? (adrResult.value as InferredADR[]) : (knowledge.inferredADRs ?? []),
      warnings,
    };
  }

  // ── Module description enrichment ────────────────────────────────────────────

  async enrichModuleDescriptions(
    modules: ReadonlyArray<{ name: string; publicApi: ReadonlyArray<{ name: string; kind: string }> }>,
    signal?: AbortSignal,
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (this.options.skipLLM) return result;

    for (const mod of modules) {
      signal?.throwIfAborted();
      const apiCtx = mod.publicApi.slice(0, 20).map((s) => `${s.kind} ${s.name}`).join('\n');
      const call = await this.safeCall<{ description: string; purpose: string }>(
        DOC_GEN_PHASES.MODULE_DESC,
        PHASE_TOKEN_BUDGETS['doc-module-desc'].input,
        () => this.callLLM(MODULE_DESC_SYSTEM_PROMPT, MODULE_DESC_USER_PROMPT(mod.name, apiCtx)),
        signal,
      );
      if (call.value?.description) result.set(mod.name, call.value.description);
    }

    return result;
  }

  // ── Dependency purpose annotation ────────────────────────────────────────────

  async enrichDependencyPurposes(
    packageNames: readonly string[],
    signal?:      AbortSignal,
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (this.options.skipLLM) return result;

    const BATCH = 20;
    for (let i = 0; i < packageNames.length; i += BATCH) {
      signal?.throwIfAborted();
      const batch = packageNames.slice(i, i + BATCH);
      const call = await this.safeCall<Record<string, string>>(
        DOC_GEN_PHASES.DEP_PURPOSE,
        PHASE_TOKEN_BUDGETS['doc-dep-purpose'].input,
        () => this.callLLM(DEP_PURPOSE_SYSTEM_PROMPT, DEP_PURPOSE_USER_PROMPT(batch)),
        signal,
      );
      if (call.value) {
        for (const [name, purpose] of Object.entries(call.value)) {
          result.set(name, purpose);
        }
      }
    }

    return result;
  }

  // ── LLM call helpers ──────────────────────────────────────────────────────────

  private async callLLM(systemPrompt: string, userPrompt: string): Promise<unknown> {
    const req: ILLMGenerateRequest = {
      systemPrompt,
      userPrompt,
      maxTokens: 2_000,
    };
    const response = await this.llm.generate(req);
    const text = response.output ?? '';
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]) as unknown;
      return text;
    } catch {
      return text;
    }
  }

  private async safeCall<T>(
    phase:     string,
    maxTokens: number,
    fn:        () => Promise<unknown>,
    signal?:   AbortSignal,
  ): Promise<LLMCallResult<T>> {
    try {
      signal?.throwIfAborted();
      const value = await this.tokenBudget.withinBudget(phase, maxTokens, fn);
      return { value: value as T, warning: null };
    } catch (err) {
      const code = this.classifyLLMError(err);
      this.logger.warn({ phase, err }, `LLM call failed: ${code}`);
      return {
        value: null,
        warning: {
          code,
          message: `${phase} LLM call failed: ${(err as Error).message}`,
          context: { phase },
        },
      };
    }
  }

  private classifyLLMError(err: unknown): 'LLM_BUDGET_EXHAUSTED' | 'LLM_TIMEOUT' | 'LLM_RESPONSE_INVALID' {
    const msg = (err as Error).message ?? '';
    if (msg.includes('BudgetExhausted') || (err as { phase?: string }).phase) return 'LLM_BUDGET_EXHAUSTED';
    if (msg.includes('timeout') || msg.includes('TIMEOUT')) return 'LLM_TIMEOUT';
    return 'LLM_RESPONSE_INVALID';
  }
}
