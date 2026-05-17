import { BaseAgent } from '../agentic/BaseAgent.js';
import type { ILLMClient } from '@oweibo/core-contracts';
import type { ISemanticMemoryStore } from '@oweibo/core-contracts';
import type { LangfuseTraceClient } from 'langfuse';
export interface EditProposal {
    proposal: Array<{
        filePath: string;
        diff: string;
        changeDescription: string;
    }>;
    newFiles: Array<{
        filePath: string;
        content: string;
    }>;
    deletedFiles: string[];
    explanation: string;
}
/**
 * GeneralCodingAgent extends BaseAgent with role 'general-coder'.
 *
 * Key differences from factory specialist agents:
 *   - system prompt is repo-aware: always prefixed with RepoMap + ProjectRules + Skills (v9.4)
 *   - proposeEdit() produces a structured EditProposal with unified diffs
 *   - no access to ArtifactBundle or PipelineOrchestrator
 */
export declare class GeneralCodingAgent extends BaseAgent {
    private readonly repoMapPrefix;
    private readonly projectRulesPrefix;
    private readonly skillsPrefix;
    constructor(llm: ILLMClient, memory: ISemanticMemoryStore, trace: LangfuseTraceClient, taskId: string, tenantId: string, repoMapPrefix: string, projectRulesPrefix: string, skillsPrefix: string);
    process(message: import('@oweibo/core-contracts').AgentMessage): Promise<import('@oweibo/core-contracts').AgentMessage>;
    /**
     * proposeEdit — generates a unified diff for a single instruction.
     * Streams diff chunks to the callback for incremental 'edit-proposed' events (G13).
     */
    proposeEdit(instruction: string, fileContents: Record<string, string>, // { filePath: content }
    codebaseContext: string, // semantic search results
    onChunk: (chunk: string, fileHint: string) => void): Promise<EditProposal>;
}
//# sourceMappingURL=GeneralCodingAgent.d.ts.map