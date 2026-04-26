import type { IGoal, ISubGoal } from '@oweibo/core-contracts';
import type { ILLMClient } from '@oweibo/core-contracts';
export declare class GoalDecomposer {
    private readonly llm;
    constructor(llm: ILLMClient);
    decompose(goal: IGoal): Promise<ISubGoal[]>;
}
//# sourceMappingURL=GoalDecomposer.d.ts.map