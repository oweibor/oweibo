"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoalDecomposer = void 0;
class GoalDecomposer {
    llm;
    templateMatcher;
    constructor(llm, opts = {}) {
        this.llm = llm;
        if (opts.templateMatcher)
            this.templateMatcher = opts.templateMatcher;
    }
    async decompose(goal, trace) {
        const startMs = Date.now();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let span;
        try {
            span = trace?.span?.({
                name: 'decompose',
                input: JSON.stringify({ description: goal.description }).slice(0, 500),
            });
        }
        catch { /* non-fatal */ }
        // ── T.2.d: pre-LLM template match (best-effort; never blocks) ────────────
        let templateMatch = null;
        if (this.templateMatcher) {
            try {
                templateMatch = await this.templateMatcher.match(goal.description);
            }
            catch {
                templateMatch = null; // matcher failure must not break decomposition
            }
        }
        const skeletonHint = templateMatch
            ? `\n\nKnown template '${templateMatch.templateId}' may apply (similarity ${templateMatch.similarity.toFixed(3)}). Pre-baked skeleton:\n${JSON.stringify(templateMatch.subGoalSkeleton, null, 2)}\n\nUse the skeleton as a starting point. Adjust to fit the specific goal; do not invent unrelated steps.`
            : '';
        const res = await this.llm.generate({
            systemPrompt: DECOMPOSER_SYSTEM_PROMPT,
            userPrompt: `Goal: ${goal.description}\nContext: ${goal.context ?? ''}${skeletonHint}\n\nDecompose into ordered sub-goals. Output JSON array.`,
            responseFormat: 'json',
        });
        const decompositionLatencyMs = Date.now() - startMs;
        let subGoals;
        try {
            const raw = JSON.parse(res.output);
            subGoals = raw.map(sg => ({
                description: sg.description ?? '',
                toolName: sg.toolName,
                input: sg.input ?? {},
                dependsOn: sg.dependsOn ?? [],
            }));
        }
        catch {
            // LLM produced unparseable output. If a template match was available,
            // its skeleton is a safer fallback than the single-step generic plan.
            if (templateMatch) {
                subGoals = templateMatch.subGoalSkeleton.map((sg) => ({
                    description: sg.description,
                    toolName: sg.toolName,
                    input: sg.input ?? {},
                    dependsOn: sg.dependsOn ?? [],
                }));
            }
            else {
                subGoals = [{ description: goal.description, toolName: 'general', input: {}, dependsOn: [] }];
            }
        }
        const subgoalCount = subGoals.length;
        const dependencyEdgeCount = subGoals.reduce((sum, sg) => sum + (sg.dependsOn?.length ?? 0), 0);
        const estimatedComplexity = subgoalCount + dependencyEdgeCount * 2;
        try {
            span?.end?.({
                output: JSON.stringify(subGoals).slice(0, 500),
                metadata: {
                    subgoal_count: subgoalCount,
                    dependency_edge_count: dependencyEdgeCount,
                    estimated_complexity: estimatedComplexity,
                    decomposition_latency_ms: decompositionLatencyMs,
                    template_match_id: templateMatch?.templateId ?? null,
                    template_match_similarity: templateMatch?.similarity ?? null,
                },
            });
        }
        catch { /* non-fatal */ }
        return subGoals;
    }
}
exports.GoalDecomposer = GoalDecomposer;
const DECOMPOSER_SYSTEM_PROMPT = `You are a task decomposer. Break a software goal into ordered sub-goals. Each sub-goal has: description, toolName (optional), input (optional object), dependsOn (array of descriptions it depends on). Output JSON array only.`;
//# sourceMappingURL=GoalDecomposer.js.map