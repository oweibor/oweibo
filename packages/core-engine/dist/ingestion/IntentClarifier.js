"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IntentClarifier = void 0;
class IntentClarifier {
    llm;
    sessions;
    constructor(llm, sessions) {
        this.llm = llm;
        this.sessions = sessions;
    }
    /**
     * classifyTaskMode — semantic routing using an LLM classifier.
     *
     * Returns 'general-coding' when the instruction references an existing repo
     * (edit, fix, refactor, add to) and 'factory' when it requests a new application
     * to be generated from scratch.
     *
     * The classifier prompt is loaded from Langfuse (name: 'general-coding/task-mode-classifier')
     * in production; the inline fallback is used in tests.
     */
    async classifyTaskMode(intent) {
        const systemPrompt = [
            'Classify the intent as "factory" (generate new app) or "general-coding" (edit existing repo).',
            'Output JSON only: { "taskMode": "factory" | "general-coding", "repoPath": string | null }',
            '"repoPath" should be the filesystem path mentioned in the instruction, or null.',
        ].join('\n');
        const userPrompt = intent.instruction;
        let taskMode = 'factory';
        let repoPath;
        try {
            const response = await this.llm.generate({ systemPrompt, userPrompt, responseFormat: 'json' });
            const parsed = JSON.parse(response.output);
            taskMode = parsed.taskMode === 'general-coding' ? 'general-coding' : 'factory';
            repoPath = parsed.repoPath ?? intent.repoPath ?? undefined;
        }
        catch {
            // Fallback: heuristic classification based on keywords
            const gcKeywords = /\b(fix|edit|refactor|add to|update|change|modify|debug|in my repo|in the codebase)\b/i;
            taskMode = gcKeywords.test(intent.instruction) ? 'general-coding' : 'factory';
            repoPath = intent.repoPath;
        }
        return { taskMode, repoPath, clarified: intent.instruction };
    }
    /**
     * buildTask — assembles a validated IAgentTask from a classified intent.
     * Validates required fields for each task mode.
     */
    buildTask(intent, classified, taskId) {
        if (classified.taskMode === 'general-coding' && !classified.repoPath) {
            throw new Error('[IntentClarifier] general-coding tasks require a repoPath. ' +
                'Ask the user which repository they want to edit.');
        }
        return {
            id: taskId,
            tenantId: intent.tenantId,
            taskMode: classified.taskMode,
            goal: { description: classified.clarified, context: intent.instruction },
            userId: intent.userId,
            sessionId: intent.sessionId,
            repoPath: classified.repoPath,
            securityContext: { permissions: ['repo:read', 'repo:write'] },
        };
    }
}
exports.IntentClarifier = IntentClarifier;
//# sourceMappingURL=IntentClarifier.js.map