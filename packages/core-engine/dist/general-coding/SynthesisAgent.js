"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SynthesisAgent = void 0;
class SynthesisAgent {
    llm;
    verifier;
    constructor(llm, verifier) {
        this.llm = llm;
        this.verifier = verifier;
    }
    /**
     * merge — called by GeneralCodingOrchestrator after all DAG nodes complete.
     * The orchestrator pre-loads conflicting file contents (keyed by file path,
     * value is the list of per-node contents for that file). SynthesisAgent
     * resolves each conflict via LLM merge and runs a final verification pass.
     */
    async merge(task, completedNodes, conflictingContentsByFile, secCtx) {
        const allEdits = completedNodes.flatMap(n => n.result?.appliedEdits ?? []);
        const totalTokens = completedNodes.reduce((sum, n) => sum + (n.result?.tokensUsed ?? 0), 0);
        const resolvedConflicts = new Map();
        for (const [file, versions] of conflictingContentsByFile) {
            if (versions.length < 2)
                continue;
            resolvedConflicts.set(file, await this.resolveConflict(file, versions));
        }
        const verificationResult = await this.verifier.run(task.repoPath, allEdits, secCtx);
        return {
            status: verificationResult.passed ? 'success' : 'partial',
            appliedEdits: allEdits,
            commitHash: completedNodes.at(-1)?.result?.commitHash,
            verificationPassed: verificationResult.passed,
            tokensUsed: totalTokens,
            resolvedConflicts,
        };
    }
    async resolveConflict(filePath, versions) {
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
exports.SynthesisAgent = SynthesisAgent;
const SYNTHESIZER_SYSTEM_PROMPT = `
You are a precise merge-conflict resolver for a multi-agent code editing system.
Your only job is to produce clean, correct merged file content when parallel agents
have modified the same file. Apply all intended changes. Preserve the coding style
of the surrounding code. Output only the merged file content — never explanations.
`.trim();
//# sourceMappingURL=SynthesisAgent.js.map