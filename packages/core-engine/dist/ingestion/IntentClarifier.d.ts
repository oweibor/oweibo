/**
 * IntentClarifier — classifies and clarifies incoming intents (v5, §16a).
 *
 * Responsibilities:
 *   1. classifyTaskMode() — semantic routing to 'factory' or 'general-coding'
 *   2. Clarification dialogue — asks the user follow-up questions when the intent
 *      is ambiguous before constructing the final IAgentTask
 *
 * The task-mode-classifier Langfuse prompt is versioned separately for A/B testing
 * (see GeneralCodingPrompts.ts for the seed).
 */
import type { ILLMClient, IAgentTask } from '@oweibo/core-contracts';
import type { SessionStore } from './SessionStore.js';
export interface RawIntent {
    readonly userId: string;
    readonly tenantId: string;
    readonly sessionId: string;
    readonly instruction: string;
    readonly repoPath?: string;
    readonly channel?: string;
}
export interface ClassifiedIntent {
    readonly taskMode: 'factory' | 'general-coding';
    readonly repoPath?: string;
    readonly clarified: string;
}
export declare class IntentClarifier {
    private readonly llm;
    private readonly sessions;
    constructor(llm: ILLMClient, sessions: SessionStore);
    /**
     * classifyTaskMode — semantic routing using an LLM classifier.
     *
     * Returns 'general-coding' when the instruction references an existing repo
     * (edit, fix, refactor, add to) and 'factory' when it requests a new application
     * to be generated from scratch.
     *
     * The classifier prompt is loaded from Langfuse (name: 'general-coding/task-mode-classifier')
     * in production; the inline fallback is used in tests.
     */
    classifyTaskMode(intent: RawIntent): Promise<ClassifiedIntent>;
    /**
     * buildTask — assembles a validated IAgentTask from a classified intent.
     * Validates required fields for each task mode.
     */
    buildTask(intent: RawIntent, classified: ClassifiedIntent, taskId: string): IAgentTask;
}
//# sourceMappingURL=IntentClarifier.d.ts.map