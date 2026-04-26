// packages/core-engine/src/general-coding/editing/EditPlanner.ts
// Pre-execution multi-file change plan (§16f.9, updated v9.5)
import type { ILLMClient } from '@oweibo/core-contracts';
import type { EditPlan, EditPlanNode } from '../ConversationalLoop.js';
import type { GeneralRepoIndexer } from '../intelligence/GeneralRepoIndexer.js';
import { randomUUID } from 'crypto';

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
export class EditPlanner {
  constructor(
    private readonly llm:     ILLMClient,
    private readonly indexer: GeneralRepoIndexer,
  ) {}

  async plan(instruction: string, repoMapText: string, collectionName: string): Promise<EditPlan> {
    const context = await this.indexer.search(collectionName, instruction, 8);

    const res = await this.llm.generate({
      systemPrompt:   EDIT_PLANNER_SYSTEM_PROMPT,
      userPrompt:     `
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
    const raw = JSON.parse(res.output) as {
      nodes: Array<{
        files: string[];
        module: string;
        changeDescription: string;
        dependsOn: number[];   // indices into the nodes array (0-based)
      }>;
      estimatedComplexity: 'simple' | 'moderate' | 'complex';
    };

    // Assign stable UUIDs and convert index-based dependsOn to id-based
    const ids = raw.nodes.map(() => randomUUID());
    const planNodes: EditPlanNode[] = raw.nodes.map((n, i) => ({
      id:                ids[i]!,
      files:             n.files,
      module:            n.module,
      changeDescription: n.changeDescription,
      dependsOn:         n.dependsOn.map(dep => ids[dep]!),
      status:            'pending',
    }));

    const plan: EditPlan = {
      instruction,
      nodes:               planNodes,
      estimatedComplexity: raw.estimatedComplexity,
      get filesToChange()  { return [...new Set(planNodes.flatMap(n => n.files))]; },
      get modulesAffected() { return [...new Set(planNodes.map(n => n.module))]; },
    };

    return plan;
  }

  /**
   * planWithFeedback — revised plan incorporating VFS pre-flight compiler errors (G16).
   */
  async planWithFeedback(
    instruction:    string,
    repoMapText:    string,
    collectionName: string,
    feedback: { previousPlan: EditPlan; compilerErrors: string; attempt: number },
  ): Promise<EditPlan> {
    const context = await this.indexer.search(collectionName, instruction, 8);

    const res = await this.llm.generate({
      systemPrompt:   EDIT_PLANNER_SYSTEM_PROMPT,
      userPrompt:     `
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

    const raw = JSON.parse(res.output) as {
      nodes: Array<{
        files: string[];
        module: string;
        changeDescription: string;
        dependsOn: number[];
      }>;
      estimatedComplexity: 'simple' | 'moderate' | 'complex';
    };

    const ids = raw.nodes.map(() => randomUUID());
    const planNodes: EditPlanNode[] = raw.nodes.map((n, i) => ({
      id:                ids[i]!,
      files:             n.files,
      module:            n.module,
      changeDescription: n.changeDescription,
      dependsOn:         n.dependsOn.map(dep => ids[dep]!),
      status:            'pending',
    }));

    return {
      instruction,
      nodes:               planNodes,
      estimatedComplexity: raw.estimatedComplexity,
      get filesToChange()  { return [...new Set(planNodes.flatMap(n => n.files))]; },
      get modulesAffected() { return [...new Set(planNodes.map(n => n.module))]; },
    };
  }
}

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
