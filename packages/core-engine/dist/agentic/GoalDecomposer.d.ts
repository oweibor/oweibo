import type { IGoal, ISubGoal, IGoalTemplateMatcher } from '@oweibo/core-contracts';
import type { ILLMClient } from '@oweibo/core-contracts';
import type { LangfuseTraceClient } from 'langfuse';
export interface GoalDecomposerOptions {
    /** Optional pre-LLM template matcher. When omitted, original LLM path runs. */
    templateMatcher?: IGoalTemplateMatcher;
}
export declare class GoalDecomposer {
    private readonly llm;
    private readonly templateMatcher?;
    constructor(llm: ILLMClient, opts?: GoalDecomposerOptions);
    decompose(goal: IGoal, trace?: LangfuseTraceClient): Promise<ISubGoal[]>;
}
//# sourceMappingURL=GoalDecomposer.d.ts.map