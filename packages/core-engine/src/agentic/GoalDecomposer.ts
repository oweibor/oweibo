// packages/core-engine/src/agentic/GoalDecomposer.ts
// Decomposes a goal into ordered sub-goals for SwarmCoordinator dispatch (§16b)
import type { IGoal, ISubGoal } from '@oweibo/core-contracts';
import type { ILLMClient } from '@oweibo/core-contracts';

export class GoalDecomposer {
  constructor(private readonly llm: ILLMClient) {}

  async decompose(goal: IGoal): Promise<ISubGoal[]> {
    const res = await this.llm.generate({
      systemPrompt:   DECOMPOSER_SYSTEM_PROMPT,
      userPrompt:     `Goal: ${goal.description}\nContext: ${goal.context ?? ''}\n\nDecompose into ordered sub-goals. Output JSON array.`,
      responseFormat: 'json',
    });

    try {
      const raw = JSON.parse(res.output) as ISubGoal[];
      return raw.map(sg => ({
        description: sg.description ?? '',
        toolName:    sg.toolName,
        input:       sg.input ?? {},
        dependsOn:   sg.dependsOn ?? [],
      }));
    } catch {
      return [{ description: goal.description, toolName: 'general', input: {}, dependsOn: [] }];
    }
  }
}

const DECOMPOSER_SYSTEM_PROMPT = `You are a task decomposer. Break a software goal into ordered sub-goals. Each sub-goal has: description, toolName (optional), input (optional object), dependsOn (array of descriptions it depends on). Output JSON array only.`;
