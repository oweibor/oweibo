/**
 * packages/core-engine/src/infrastructure/PromptBudgetEnforcer.ts
 *
 * PromptBudgetEnforcer — pre-call token accounting for any assembled LLM prompt (§22.26).
 *
 * Sits in the prompt assembly chain immediately AFTER `skills` injection and BEFORE
 * the assembled prompt is frozen and passed to LLM.stream()/complete().
 *
 * Full chain order:
 *   repoMap → projectRules → skills → [PromptBudgetEnforcer] → systemPrompt (sent to LLM)
 *
 * Responsibilities:
 *   1. Measure total assembled prompt tokens using the generation model's tokenizer.
 *   2. If total exceeds (contextWindow − reservedGenerationTokens), trim in priority order:
 *        a. Conversation history (drop oldest turns first)
 *        b. Skills block (truncate from the end)
 *        c. Project rules (truncate from the end)
 *        d. Repo map (truncate from the end)
 *        e. If still over: emit 'context-overflow' event and include overflow notice in trimReport.
 *   3. Always emit a 'cost-estimated' event before the LLM call.
 *
 * Configuration (read from constructor parameters, defaulting if not provided):
 *   - contextWindowTokens   default 200_000  (claude-sonnet-4-6 context window)
 *   - reservedTokens        default   8_000  (held back for model response)
 *   - costPerMillionTokens  default      15  (USD — approximate claude-sonnet-4-6 input cost)
 *
 * The enforcer is stateless — a new instance may be created per LLM call, or a single
 * instance may be shared across calls (all state is in the AssembledPrompt arguments).
 */
import type { ModelRouter } from './ModelRouter.js';
import type { TaskEventBus } from '../ingestion/TaskEventBus.js';
export interface AssembledPrompt {
    /** Raw repo map text (RepoMapBuilder output). */
    repoMap: string;
    /** Project rules block (ProjectRulesLoader output). */
    projectRules: string;
    /** Skills injection block (SkillRegistry output). */
    skills: string;
    /** Fixed system prompt for this agent role (from Langfuse / inline constant). */
    systemPrompt: string;
    /** Conversation history from ConversationalLoop / context store. */
    conversationHistory: Array<{
        role: 'user' | 'assistant';
        content: string;
    }>;
    /** The user's instruction for this turn. */
    userInstruction: string;
}
export interface BudgetedPrompt {
    /**
     * Final system prompt to send to the LLM.
     * Contains: systemPrompt + repoMap + projectRules + skills (all potentially trimmed).
     */
    systemPrompt: string;
    /** Conversation history (potentially trimmed from the front). */
    messages: Array<{
        role: 'user' | 'assistant';
        content: string;
    }>;
    /** Total token count of the budgeted prompt (post-trim). */
    totalTokens: number;
    /** True if any trimming was applied. */
    wasTrimmed: boolean;
    /** Human-readable list of each trim operation performed. */
    trimReport: string[];
}
export interface PromptBudgetConfig {
    /** Total context window of the generation model in tokens. Default: 200_000. */
    contextWindowTokens?: number;
    /** Tokens reserved for the model's response. Default: 8_000. */
    reservedGenerationTokens?: number;
    /** Input cost in USD per million tokens (for cost-estimated event). Default: 15. */
    costPerMillionInputTokens?: number;
}
export declare class PromptBudgetEnforcer {
    private readonly modelRouter;
    private readonly eventBus;
    private readonly contextWindow;
    private readonly reservedTokens;
    private readonly costPerMillion;
    constructor(modelRouter: ModelRouter, eventBus: TaskEventBus, config?: PromptBudgetConfig);
    /**
     * enforce — measure the assembled prompt, trim if necessary, publish events.
     *
     * @param prompt    The fully assembled prompt components.
     * @param taskId    Used as the event taskId for TaskEventBus.publish().
     * @param sessionId Used as the channel key for TaskEventBus.publish().
     * @returns         A BudgetedPrompt ready to pass to LLM.stream()/complete().
     */
    enforce(prompt: AssembledPrompt, taskId: string, sessionId: string): Promise<BudgetedPrompt>;
}
//# sourceMappingURL=PromptBudgetEnforcer.d.ts.map