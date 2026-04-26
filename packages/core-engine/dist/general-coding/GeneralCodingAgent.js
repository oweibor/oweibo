"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeneralCodingAgent = void 0;
// packages/core-engine/src/general-coding/GeneralCodingAgent.ts
// BaseAgent subclass for general-coding tasks (§16f.2)
const BaseAgent_js_1 = require("../agentic/BaseAgent.js");
/**
 * GeneralCodingAgent extends BaseAgent with role 'general-coder'.
 *
 * Key differences from factory specialist agents:
 *   - system prompt is repo-aware: always prefixed with RepoMap + ProjectRules + Skills (v9.4)
 *   - proposeEdit() produces a structured EditProposal with unified diffs
 *   - no access to ArtifactBundle or PipelineOrchestrator
 */
class GeneralCodingAgent extends BaseAgent_js_1.BaseAgent {
    repoMapPrefix;
    projectRulesPrefix;
    skillsPrefix;
    constructor(llm, memory, trace, taskId, tenantId, repoMapPrefix, projectRulesPrefix, skillsPrefix) {
        super('general-coder', llm, memory, GENERAL_CODER_SYSTEM_PROMPT, trace, taskId, tenantId);
        this.repoMapPrefix = repoMapPrefix;
        this.projectRulesPrefix = projectRulesPrefix;
        this.skillsPrefix = skillsPrefix;
    }
    async process(message) {
        const out = await this.llm.generate({
            systemPrompt: GENERAL_CODER_SYSTEM_PROMPT,
            userPrompt: typeof message.payload === 'string' ? message.payload : JSON.stringify(message.payload),
        });
        return this.respond(message, out.output ?? '');
    }
    /**
     * proposeEdit — generates a unified diff for a single instruction.
     * Streams diff chunks to the callback for incremental 'edit-proposed' events (G13).
     */
    async proposeEdit(instruction, fileContents, // { filePath: content }
    codebaseContext, // semantic search results
    onChunk) {
        const systemPrompt = [
            this.repoMapPrefix,
            this.projectRulesPrefix,
            this.skillsPrefix,
            GENERAL_CODER_SYSTEM_PROMPT,
        ].filter(Boolean).join('\n\n---\n\n');
        const userPrompt = `Codebase context (semantic search results):
${codebaseContext}

Current file contents:
${Object.entries(fileContents).map(([p, c]) => `### ${p}\n\`\`\`\n${c}\n\`\`\``).join('\n\n')}

Instruction: ${instruction}

Produce a unified diff for each file that needs to change. Output JSON:
{
  "proposal": [{ "filePath": string, "diff": string, "changeDescription": string }],
  "newFiles": [{ "filePath": string, "content": string }],
  "deletedFiles": string[],
  "explanation": string
}`.trim();
        let accumulated = '';
        if (!this.llm.stream)
            throw new Error('[GeneralCodingAgent] LLM client does not support streaming');
        for await (const chunk of this.llm.stream({ systemPrompt, userPrompt })) {
            accumulated += chunk;
            const fileHint = chunk.match(/"filePath"\s*:\s*"([^"]+)"/)?.[1] ?? '';
            onChunk(chunk, fileHint);
        }
        return JSON.parse(accumulated);
    }
}
exports.GeneralCodingAgent = GeneralCodingAgent;
const GENERAL_CODER_SYSTEM_PROMPT = `You are a precise, expert software engineer making targeted edits to an existing codebase.

Rules:
- Always produce minimal, targeted diffs. Never rewrite files that don't need to change.
- Respect the project's existing naming conventions, import style, and architectural patterns.
- Prefer editing existing abstractions over creating new ones unless the instruction requires it.
- When adding code, match the indentation, quote style, and comment style of the surrounding code.
- If an instruction is ambiguous, make the safest, most conservative interpretation.
- Never remove tests. Never disable linting rules. Never introduce any-casts unless absolutely required.
- Output only the JSON structure specified. No preamble.`;
//# sourceMappingURL=GeneralCodingAgent.js.map