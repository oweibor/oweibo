"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoalDecomposer = void 0;
class GoalDecomposer {
    llm;
    constructor(llm) {
        this.llm = llm;
    }
    async decompose(goal) {
        const res = await this.llm.generate({
            systemPrompt: DECOMPOSER_SYSTEM_PROMPT,
            userPrompt: `Goal: ${goal.description}\nContext: ${goal.context ?? ''}\n\nDecompose into ordered sub-goals. Output JSON array.`,
            responseFormat: 'json',
        });
        try {
            const raw = JSON.parse(res.output);
            return raw.map(sg => ({
                description: sg.description ?? '',
                toolName: sg.toolName,
                input: sg.input ?? {},
                dependsOn: sg.dependsOn ?? [],
            }));
        }
        catch {
            return [{ description: goal.description, toolName: 'general', input: {}, dependsOn: [] }];
        }
    }
}
exports.GoalDecomposer = GoalDecomposer;
const DECOMPOSER_SYSTEM_PROMPT = `You are a task decomposer. Break a software goal into ordered sub-goals. Each sub-goal has: description, toolName (optional), input (optional object), dependsOn (array of descriptions it depends on). Output JSON array only.`;
//# sourceMappingURL=GoalDecomposer.js.map