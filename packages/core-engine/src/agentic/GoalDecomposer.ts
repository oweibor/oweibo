// packages/core-engine/src/agentic/GoalDecomposer.ts
// Decomposes a goal into ordered sub-goals for SwarmCoordinator dispatch (§16b).
//
// T.2.d augments the original LLM path with an optional pre-LLM template
// match: if an IGoalTemplateMatcher is provided AND the incoming goal
// matches a known template above the matcher's similarity threshold, the
// template's pre-baked sub-goal skeleton is used as the *seed* for the LLM
// rather than expecting the LLM to start from scratch. The LLM still
// produces the final decomposition, but it now reads the skeleton as a
// reference. When no matcher is wired OR no template clears the threshold,
// behavior is byte-identical to the pre-T.2.d code path.
import type { IGoal, ISubGoal, IGoalTemplateMatcher, GoalTemplateMatch } from '@oweibo/core-contracts';
import type { ILLMClient } from '@oweibo/core-contracts';
import type { LangfuseTraceClient } from 'langfuse';

export interface GoalDecomposerOptions {
  /** Optional pre-LLM template matcher. When omitted, original LLM path runs. */
  templateMatcher?: IGoalTemplateMatcher;
}

export class GoalDecomposer {
  private readonly templateMatcher?: IGoalTemplateMatcher;

  constructor(private readonly llm: ILLMClient, opts: GoalDecomposerOptions = {}) {
    if (opts.templateMatcher) this.templateMatcher = opts.templateMatcher;
  }

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

    // ── T.2.d: pre-LLM template match (best-effort; never blocks) ────────────
    let templateMatch: GoalTemplateMatch | null = null;
    if (this.templateMatcher) {
      try {
        templateMatch = await this.templateMatcher.match(goal.description);
      } catch {
        templateMatch = null; // matcher failure must not break decomposition
      }
    }

    const skeletonHint = templateMatch
      ? `\n\nKnown template '${templateMatch.templateId}' may apply (similarity ${templateMatch.similarity.toFixed(3)}). Pre-baked skeleton:\n${JSON.stringify(templateMatch.subGoalSkeleton, null, 2)}\n\nUse the skeleton as a starting point. Adjust to fit the specific goal; do not invent unrelated steps.`
      : '';

    const res = await this.llm.generate({
      systemPrompt:   DECOMPOSER_SYSTEM_PROMPT,
      userPrompt:     `Goal: ${goal.description}\nContext: ${goal.context ?? ''}${skeletonHint}\n\nDecompose into ordered sub-goals. Output JSON array.`,
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
      // LLM produced unparseable output. If a template match was available,
      // its skeleton is a safer fallback than the single-step generic plan.
      if (templateMatch) {
        subGoals = templateMatch.subGoalSkeleton.map((sg) => ({
          description: sg.description,
          toolName:    sg.toolName,
          input:       sg.input ?? {},
          dependsOn:   sg.dependsOn ?? [],
        }));
      } else {
        subGoals = [{ description: goal.description, toolName: 'general', input: {}, dependsOn: [] }];
      }
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
          template_match_id:         templateMatch?.templateId ?? null,
          template_match_similarity: templateMatch?.similarity ?? null,
        },
      });
    } catch { /* non-fatal */ }

    return subGoals;
  }
}

const DECOMPOSER_SYSTEM_PROMPT = `You are a task decomposer. Break a software goal into ordered sub-goals. Each sub-goal has: description, toolName (optional), input (optional object), dependsOn (array of descriptions it depends on). Output JSON array only.`;
