/**
 * Component token budgets for a single LLM call.
 * All values are in tokens; must sum to <= totalBudget.
 */
export interface TokenAllocation {
    systemPrompt: number;
    repoMap: number;
    projectRules: number;
    skills: number;
    conversationHistory: number;
    userInstruction: number;
    reservedForGeneration: number;
}
export interface AllocationInput {
    contextWindowTokens: number;
    reservedForGeneration: number;
    systemPromptTokens: number;
    repoMapTokens: number;
    projectRulesTokens: number;
    skillsTokens: number;
    conversationHistoryTokens: number;
    userInstructionTokens: number;
}
export interface AllocationResult {
    allocation: TokenAllocation;
    /** Tokens trimmed from each component to fit within budget. */
    trimmed: Omit<TokenAllocation, 'reservedForGeneration'>;
    totalUsed: number;
    overBudget: boolean;
}
/**
 * Trim priority order (lower index = trimmed first):
 *   1. conversationHistory  — oldest turns first
 *   2. skills               — truncate from end
 *   3. projectRules         — truncate from end
 *   4. repoMap              — truncate from end
 *   5. systemPrompt + userInstruction are never trimmed
 */
export declare function allocateTokenBudget(input: AllocationInput): AllocationResult;
/**
 * Estimate token count from a string using the ~4 chars/token heuristic.
 * Suitable for budgeting decisions; not a substitute for a proper tokenizer.
 */
export declare function estimateTokens(text: string): number;
/**
 * Truncate text so its estimated token count fits within maxTokens.
 * Preserves leading content (head truncation).
 */
export declare function truncateToTokenBudget(text: string, maxTokens: number): string;
//# sourceMappingURL=ContextWindowAllocator.d.ts.map