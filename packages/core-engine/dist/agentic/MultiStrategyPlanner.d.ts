import type { IGoal, Plan } from '@oweibo/core-contracts';
import type { ILLMClient } from '@oweibo/core-contracts';
export declare class MultiStrategyPlanner {
    private readonly llm;
    constructor(llm: ILLMClient);
    generatePlans(goal: IGoal): Promise<Plan[]>;
    selectBest(plans: Plan[]): Plan;
}
//# sourceMappingURL=MultiStrategyPlanner.d.ts.map