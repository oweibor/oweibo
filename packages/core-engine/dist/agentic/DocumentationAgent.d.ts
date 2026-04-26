import type { ILLMClient } from '@oweibo/core-contracts';
export interface DocInput {
    knowledgeArtifact?: unknown;
    clarificationHistory: string;
    adrs: unknown[];
    testSummaries: string[];
}
export interface ArtifactFile {
    path: string;
    content: string;
}
/**
 * DocumentationAgent — fifth swarm specialist (role: 'documentation-writer').
 *
 * Runs in parallel with SmokeTestStage after ReviewerAgent clears the output.
 * Listed as safe under AsyncHITLCoordinator.safePatterns — does not require HITL.
 *
 * Produces three files (v8 spec §16d.7):
 *   docs/user-guide.md      — task-oriented guide written for the end user
 *   docs/developer.md       — technical reference for module integrators
 *   docs/api-reference.md   — endpoint and event catalogue from ModuleKnowledge
 *
 * Each file is generated from a dedicated Langfuse prompt template:
 *   'doc-user-guide-system', 'doc-developer-system', 'doc-api-reference-system'
 *
 * Falls back to inline prompts when Langfuse is unavailable.
 */
export declare class DocumentationAgent {
    private readonly llm;
    constructor(llm: ILLMClient);
    generateDocs(input: DocInput): Promise<ArtifactFile[]>;
}
//# sourceMappingURL=DocumentationAgent.d.ts.map