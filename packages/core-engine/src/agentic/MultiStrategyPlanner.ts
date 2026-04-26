// packages/core-engine/src/agentic/MultiStrategyPlanner.ts
// Generates and selects candidate execution plans (§16b)
import type { IGoal, Plan } from '@oweibo/core-contracts';
import type { ILLMClient } from '@oweibo/core-contracts';

export class MultiStrategyPlanner {
  constructor(private readonly llm: ILLMClient) {}

  async generatePlans(goal: IGoal): Promise<Plan[]> {
    const res = await this.llm.generate({
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      userPrompt:   `Goal: ${goal.description}\nContext: ${goal.context ?? ''}\n\nGenerate 2-3 alternative plans. Output JSON array of Plan objects.`,
      responseFormat: 'json',
    });

    try {
      const raw = JSON.parse(res.output) as Plan[];
      return raw.map((p, i) => ({
        id:               p.id ?? `plan-${i}`,
        strategy:         p.strategy ?? '',
        subGoals:         p.subGoals ?? [],
        feasibilityScore: p.feasibilityScore ?? 0.8,
        riskScore:        p.riskScore ?? 0.2,
        estimatedTokens:  p.estimatedTokens ?? 5000,
      }));
    } catch {
      // Fallback: single direct-execution plan
      return [{
        id:               'plan-0',
        strategy:         goal.description,
        subGoals:         [],
        feasibilityScore: 0.8,
        riskScore:        0.2,
        estimatedTokens:  5000,
      }];
    }
  }

  selectBest(plans: Plan[]): Plan {
    // Score = feasibilityScore - riskScore; pick highest
    return plans.reduce((best, p) =>
      (p.feasibilityScore - p.riskScore) > (best.feasibilityScore - best.riskScore) ? p : best,
    );
  }
}

const PLANNER_SYSTEM_PROMPT = `You are a software project planner. Given a goal, generate 2-3 alternative execution strategies. Each strategy has a feasibility score (0-1) and risk score (0-1). Output a JSON array of Plan objects with fields: id, strategy, subGoals (array of {description, toolName, input, dependsOn}), feasibilityScore, riskScore, estimatedTokens.`;
