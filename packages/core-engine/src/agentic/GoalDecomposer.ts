// packages/core-engine/src/agentic/GoalDecomposer.ts
// Decomposes a goal into ordered sub-goals for SwarmCoordinator dispatch (§16b)
import type { IGoal, ISubGoal } from '@oweibo/core-contracts';
import type { ILLMClient } from '@oweibo/core-contracts';
import type { LangfuseTraceClient } from 'langfuse';

export class GoalDecomposer {
  constructor(private readonly llm: ILLMClient) {}

  async decompose(goal: IGoal, trace?: LangfuseTraceClient): Promise<ISubGoal[]> {
    const startMs = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let span: any;
    try {
      span = trace?.span?.({
        name:  'decompose',
        input: JSON.stringify({ description: goal.description }).slice(0, 500),
      });
    } catch { /* non-fatal */ }

    const res = await this.llm.generate({
      systemPrompt:   DECOMPOSER_SYSTEM_PROMPT,
      userPrompt:     `Goal: ${goal.description}\nContext: ${goal.context ?? ''}\n\nDecompose into ordered sub-goals. Output JSON array.`,
      responseFormat: 'json',
    });

    const decompositionLatencyMs = Date.now() - startMs;

    let subGoals: ISubGoal[];
    try {
      const raw = JSON.parse(res.output) as ISubGoal[];
      subGoals = raw.map(sg => ({
        description: sg.description ?? '',
        toolName:    sg.toolName,
        input:       sg.input ?? {},
        dependsOn:   sg.dependsOn ?? [],
      }));
    } catch {
      subGoals = [{ description: goal.description, toolName: 'general', input: {}, dependsOn: [] }];
    }

    const subgoalCount       = subGoals.length;
    const dependencyEdgeCount = subGoals.reduce((sum, sg) => sum + (sg.dependsOn?.length ?? 0), 0);
    const estimatedComplexity = subgoalCount + dependencyEdgeCount * 2;

    try {
      span?.end?.({
        output:   JSON.stringify(subGoals).slice(0, 500),
        metadata: {
          subgoal_count:             subgoalCount,
          dependency_edge_count:     dependencyEdgeCount,
          estimated_complexity:      estimatedComplexity,
          decomposition_latency_ms:  decompositionLatencyMs,
        },
      });
    } catch { /* non-fatal */ }

    return subGoals;
  }
}

const DECOMPOSER_SYSTEM_PROMPT = `You are a task decomposer. Break a software goal into ordered sub-goals. Each sub-goal has: description, toolName (optional), input (optional object), dependsOn (array of descriptions it depends on). Output JSON array only.`;
