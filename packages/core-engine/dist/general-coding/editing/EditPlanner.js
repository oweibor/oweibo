"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EditPlanner = void 0;
const crypto_1 = require("crypto");
/**
 * EditPlanner — separates "what needs to change" from "make the changes".
 *
 * v9.5: Returns a DAG EditPlan. The LLM is prompted to identify inter-file
 * dependencies so that truly independent changes can be dispatched in parallel
 * while genuinely dependent changes are sequenced correctly.
 *
 * A flat plan (all nodes with dependsOn: []) is a valid degenerate case —
 * all nodes will be dispatched in parallel from the first tick.
 *
 * The plan is:
 *   - surfaced to the user as a 'plan-ready' event (G11) with the full DAG
 *   - driven by GeneralCodingOrchestrator's reactive dispatch loop (v9.5)
 *   - persisted in DistributedContextStore for worker-restart resilience
 */
class EditPlanner {
    llm;
    indexer;
    constructor(llm, indexer) {
        this.llm = llm;
        this.indexer = indexer;
    }
    async plan(instruction, repoMapText, collectionName) {
        const context = await this.indexer.search(collectionName, instruction, 8);
        const res = await this.llm.generate({
            systemPrompt: EDIT_PLANNER_SYSTEM_PROMPT,
            userPrompt: `
Repo map:
${repoMapText}

Semantic search results (most relevant code):
${context}

Instruction: ${instruction}

Identify every file that needs to change to implement this instruction completely.
Group files into nodes — one node per logical unit of work (typically one module or one cross-cutting concern).
For each node, identify which other nodes it depends on (must complete before this node starts).
Nodes with no dependencies can be executed in parallel from the start.
      `.trim(),
            responseFormat: 'json',
        });
        // v9.5: LLM returns DAG nodes instead of a flat file list
        const raw = JSON.parse(res.output);
        // Assign stable UUIDs and convert index-based dependsOn to id-based
        const ids = raw.nodes.map(() => (0, crypto_1.randomUUID)());
        const planNodes = raw.nodes.map((n, i) => ({
            id: ids[i],
            files: n.files,
            module: n.module,
            changeDescription: n.changeDescription,
            dependsOn: n.dependsOn.map(dep => ids[dep]),
            status: 'pending',
        }));
        const plan = {
            instruction,
            nodes: planNodes,
            estimatedComplexity: raw.estimatedComplexity,
            get filesToChange() { return [...new Set(planNodes.flatMap(n => n.files))]; },
            get modulesAffected() { return [...new Set(planNodes.map(n => n.module))]; },
        };
        return plan;
    }
    /**
     * planWithFeedback — revised plan incorporating VFS pre-flight compiler errors (G16).
     */
    async planWithFeedback(instruction, repoMapText, collectionName, feedback) {
        const context = await this.indexer.search(collectionName, instruction, 8);
        const res = await this.llm.generate({
            systemPrompt: EDIT_PLANNER_SYSTEM_PROMPT,
            userPrompt: `
Repo map:
${repoMapText}

Semantic search results:
${context}

Instruction: ${instruction}

PREVIOUS PLAN FAILED PRE-FLIGHT COMPILATION (attempt ${feedback.attempt + 1}/3):
${feedback.compilerErrors}

Revise your plan to fix all compiler errors.
      `.trim(),
            responseFormat: 'json',
        });
        const raw = JSON.parse(res.output);
        const ids = raw.nodes.map(() => (0, crypto_1.randomUUID)());
        const planNodes = raw.nodes.map((n, i) => ({
            id: ids[i],
            files: n.files,
            module: n.module,
            changeDescription: n.changeDescription,
            dependsOn: n.dependsOn.map(dep => ids[dep]),
            status: 'pending',
        }));
        return {
            instruction,
            nodes: planNodes,
            estimatedComplexity: raw.estimatedComplexity,
            get filesToChange() { return [...new Set(planNodes.flatMap(n => n.files))]; },
            get modulesAffected() { return [...new Set(planNodes.map(n => n.module))]; },
        };
    }
}
exports.EditPlanner = EditPlanner;
const EDIT_PLANNER_SYSTEM_PROMPT = `
You are a code change planner. Given a natural language instruction, a repo map,
and relevant code context, identify every file that needs to change and why.
Then group those files into parallel-safe work nodes with explicit dependencies.

Rules:
- List ALL files that need changes — omitting a file is worse than including an extra one.
- Group files into nodes by logical unit (module boundary, cross-cutting concern, etc.).
- A node's dependsOn lists the 0-based indices of nodes that must complete before it starts.
- If two nodes can safely run in parallel, do NOT add a dependency between them.
- Classify complexity: simple (1-3 files, 1 module), moderate (4-6 files, 1-2 modules), complex (7+ files or 3+ modules).

Output JSON only:
{
  "nodes": [
    {
      "files": string[],
      "module": string,
      "changeDescription": string,
      "dependsOn": number[]
    }
  ],
  "estimatedComplexity": "simple" | "moderate" | "complex"
}
`;
//# sourceMappingURL=EditPlanner.js.map