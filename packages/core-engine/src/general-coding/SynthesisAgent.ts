// packages/core-engine/src/general-coding/SynthesisAgent.ts
// Merges parallel DAG node outputs into a coherent result (§16f.2b, NEW v9.5)
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
  status:             'success' | 'failed' | 'partial';
  appliedEdits:       string[];
  commitHash?:        string;
  verificationPassed: boolean;
  tokensUsed:         number;
  /** Merged file contents for conflicting files. Caller writes these to disk / context store. */
  resolvedConflicts:  Map<string, string>;
}

export class SynthesisAgent {
  constructor(
    private readonly llm:      ILLMClient,
    private readonly verifier: VerificationRunner,
  ) {}

  /**
   * merge — called by GeneralCodingOrchestrator after all DAG nodes complete.
   * The orchestrator pre-loads conflicting file contents (keyed by file path,
   * value is the list of per-node contents for that file). SynthesisAgent
   * resolves each conflict via LLM merge and runs a final verification pass.
   */
  async merge(
    task:                      IAgentTask,
    completedNodes:            EditPlanNode[],
    conflictingContentsByFile: Map<string, string[]>,
    secCtx:                    ISecurityContext,
  ): Promise<SynthesisOutcome> {
    const allEdits    = completedNodes.flatMap(n => n.result?.appliedEdits ?? []);
    const totalTokens = completedNodes.reduce((sum, n) => sum + (n.result?.tokensUsed ?? 0), 0);

    const resolvedConflicts = new Map<string, string>();
    for (const [file, versions] of conflictingContentsByFile) {
      if (versions.length < 2) continue;
      resolvedConflicts.set(file, await this.resolveConflict(file, versions));
    }

    const verificationResult = await this.verifier.run(task.repoPath!, allEdits, secCtx);

    return {
      status:             verificationResult.passed ? 'success' : 'partial',
      appliedEdits:       allEdits,
      commitHash:         completedNodes.at(-1)?.result?.commitHash,
      verificationPassed: verificationResult.passed,
      tokensUsed:         totalTokens,
      resolvedConflicts,
    };
  }

  private async resolveConflict(filePath: string, versions: string[]): Promise<string> {
    const userPrompt = `
The following versions of "${filePath}" were produced by parallel editing agents.
Produce a single merged version that incorporates all intended changes correctly.
Output ONLY the merged file content — no explanation.

${versions.map((v, i) => `=== Version ${i + 1} ===\n${v}`).join('\n\n')}
    `.trim();
    const { output } = await this.llm.generate({ systemPrompt: SYNTHESIZER_SYSTEM_PROMPT, userPrompt });
    return output;
  }
}

const SYNTHESIZER_SYSTEM_PROMPT = `
You are a precise merge-conflict resolver for a multi-agent code editing system.
Your only job is to produce clean, correct merged file content when parallel agents
have modified the same file. Apply all intended changes. Preserve the coding style
of the surrounding code. Output only the merged file content — never explanations.
`.trim();
