import type { ILLMClient, IAgentTask, ISecurityContext } from '@oweibo/core-contracts';
import type { VerificationRunner } from './editing/VerificationRunner.js';
import type { EditPlanNode } from './ConversationalLoop.js';
/**
 * SynthesisAgent — role: 'synthesizer' (NEW v9.5).
 *
 * Responsibilities:
 *   1. Resolve any file-level conflicts between parallel edits, given the
 *      conflicting per-node file contents pre-loaded by the orchestrator.
 *   2. Run VerificationRunner once across the full merged changeset
 *      (tsc --noEmit → ESLint → targeted Jest on all affected files).
 *   3. Return a SynthesisOutcome the orchestrator can fold into its result.
 *
 * Design constraints (dependency-cruiser `no-synthesizer-factory-import`):
 *   - May only import GeneralCodingAgent types, ConversationalLoop types,
 *     and VerificationRunner from core-engine/src.
 *   - Must NOT import BaseAgent, LongTermMemoryStore, DistributedContextStore,
 *     TaskEventBus, GeneralCodingOrchestrator, SwarmCoordinator, PipelineOrchestrator,
 *     or any factory module. The orchestrator owns all I/O and event emission;
 *     SynthesisAgent is a pure merge+verify function.
 */
export interface SynthesisOutcome {
    status: 'success' | 'failed' | 'partial';
    appliedEdits: string[];
    commitHash?: string;
    verificationPassed: boolean;
    tokensUsed: number;
    /** Merged file contents for conflicting files. Caller writes these to disk / context store. */
    resolvedConflicts: Map<string, string>;
}
export declare class SynthesisAgent {
    private readonly llm;
    private readonly verifier;
    constructor(llm: ILLMClient, verifier: VerificationRunner);
    /**
     * merge — called by GeneralCodingOrchestrator after all DAG nodes complete.
     * The orchestrator pre-loads conflicting file contents (keyed by file path,
     * value is the list of per-node contents for that file). SynthesisAgent
     * resolves each conflict via LLM merge and runs a final verification pass.
     */
    merge(task: IAgentTask, completedNodes: EditPlanNode[], conflictingContentsByFile: Map<string, string[]>, secCtx: ISecurityContext): Promise<SynthesisOutcome>;
    private resolveConflict;
}
//# sourceMappingURL=SynthesisAgent.d.ts.map