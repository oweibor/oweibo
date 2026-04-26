/**
 * PromptBudgetEnforcer — assembles and token-budgets agent system prompts.
 *
 * Two orderings to keep distinct:
 *
 *   EVICTION order (what gets dropped first under budget pressure):
 *     repoMap → conversationHistory → warmMemory → skills → projectRules
 *
 *   ASSEMBLY order (position in the final prompt string):
 *     systemPrompt → userProfile → projectRules → skills →
 *     warmMemory → conversationHistory → repoMap
 *
 * These are inverses: the lowest-value component (repoMap) is evicted first
 * and assembled last. systemPrompt and userProfile are protected — they are
 * neither truncated nor evicted regardless of budget pressure.
 *
 * Partial fit: when a component's token count exceeds the remaining budget but
 * some budget is still available, the component is character-sliced to fit and
 * truncationSuffix is appended. The component name is recorded in truncations[].
 *
 * Token counting: Math.ceil(text.length / 4) — character heuristic,
 * consistent with the project-wide pattern (no tokenizer available here).
 */
export interface BudgetConfig {
    maxTotalTokens: number;
    reservedForCompletion: number;
    truncationSuffix: string;
}
export declare const DEFAULT_BUDGET_CONFIG: BudgetConfig;
export interface PromptComponents {
    systemPrompt: string;
    userProfile?: string;
    warmMemory?: string;
    skills?: string;
    projectRules?: string;
    conversationHistory?: string;
    repoMap?: string;
}
export interface EnforcerResult {
    assembled: string;
    totalTokens: number;
    truncations: string[];
}
export declare class PromptBudgetEnforcer {
    private readonly config;
    constructor(config?: BudgetConfig);
    private countTokens;
    /**
     * enforce — fit prompt components within the token budget and assemble.
     *
     * Protected (never evicted): systemPrompt, userProfile.
     * Eviction order: repoMap → conversationHistory → warmMemory → skills → projectRules.
     * Assembly order: systemPrompt → userProfile → projectRules → skills →
     *                 warmMemory → conversationHistory → repoMap.
     */
    enforce(components: PromptComponents): EnforcerResult;
}
//# sourceMappingURL=PromptBudgetEnforcer.d.ts.map