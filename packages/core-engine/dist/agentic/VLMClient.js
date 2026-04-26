"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OllamaVLMClient = void 0;
class OllamaVLMClient {
    baseUrl;
    model;
    constructor(baseUrl = 'http://localhost:11434', model = 'llava') {
        this.baseUrl = baseUrl;
        this.model = model;
    }
    async analyzeScreenshot(screenshotBase64, prompt) {
        const res = await fetch(`${this.baseUrl}/api/generate`, {
            method: 'POST',
            body: JSON.stringify({
                model: this.model,
                prompt: `${prompt}\n\nRespond ONLY with valid JSON matching the VLMAnalysis schema.`,
                images: [screenshotBase64],
                stream: false,
                format: 'json',
            }),
        });
        const data = await res.json();
        try {
            return JSON.parse(data.response);
        }
        catch {
            return {
                description: data.response,
                uiElements: [],
                actionSuggestions: [],
                errorDetected: false,
            };
        }
    }
    async reason(screenshotBase64, currentGoal, previousActions) {
        const res = await fetch(`${this.baseUrl}/api/generate`, {
            method: 'POST',
            body: JSON.stringify({
                model: this.model,
                prompt: `
You are a visual reasoning engine for an autonomous AI agent.
Current goal: ${currentGoal}
Previous actions taken: ${previousActions.join('; ')}

Analyze the screenshot and reason about:
1. Is the current visual state a blocker, warning, info, or success relative to the goal?
2. What does this state imply for the task? Be specific about cause.
3. What should the agent do next?
4. Does this require human review (irreversible change, security prompt, unexpected data loss)?

Respond ONLY with valid JSON matching: { taskRelevance, implication, suggestedNextAction, requiresHumanReview }
        `.trim(),
                images: [screenshotBase64],
                stream: false,
                format: 'json',
            }),
        });
        const data = await res.json();
        try {
            return JSON.parse(data.response);
        }
        catch {
            return {
                taskRelevance: 'info',
                implication: data.response,
                suggestedNextAction: 'Continue with caution; VLM reasoning parse failed.',
                requiresHumanReview: false,
            };
        }
    }
}
exports.OllamaVLMClient = OllamaVLMClient;
//# sourceMappingURL=VLMClient.js.map