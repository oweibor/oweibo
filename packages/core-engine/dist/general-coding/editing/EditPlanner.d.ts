import type { ILLMClient } from '@oweibo/core-contracts';
import type { EditPlan } from '../ConversationalLoop.js';
import type { GeneralRepoIndexer } from '../intelligence/GeneralRepoIndexer.js';
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
export declare class EditPlanner {
    private readonly llm;
    private readonly indexer;
    constructor(llm: ILLMClient, indexer: GeneralRepoIndexer);
    plan(instruction: string, repoMapText: string, collectionName: string): Promise<EditPlan>;
    /**
     * planWithFeedback — revised plan incorporating VFS pre-flight compiler errors (G16).
     */
    planWithFeedback(instruction: string, repoMapText: string, collectionName: string, feedback: {
        previousPlan: EditPlan;
        compilerErrors: string;
        attempt: number;
    }): Promise<EditPlan>;
}
//# sourceMappingURL=EditPlanner.d.ts.map