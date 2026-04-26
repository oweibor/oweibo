// packages/core-engine/src/agentic/VLMClient.ts
export interface VLMAnalysis {
  description: string;
  uiElements: Array<{ selector: string; type: string; label: string }>;
  actionSuggestions: Array<{ action: 'click' | 'type' | 'scroll'; target: string; value?: string }>;
  errorDetected: boolean;
  errorMessage?: string;
}

export interface ContextualVisualReasoning {
  taskRelevance: 'blocker' | 'warning' | 'info' | 'success';
  implication: string;
  suggestedNextAction: string;
  requiresHumanReview: boolean;
}

export class OllamaVLMClient {
  constructor(
    private readonly baseUrl: string = 'http://localhost:11434',
    private readonly model: string = 'llava',
  ) {}

  async analyzeScreenshot(screenshotBase64: string, prompt: string): Promise<VLMAnalysis> {
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

    const data = await res.json() as { response: string };
    try {
      return JSON.parse(data.response) as VLMAnalysis;
    } catch {
      return {
        description: data.response,
        uiElements: [],
        actionSuggestions: [],
        errorDetected: false,
      };
    }
  }

  async reason(
    screenshotBase64: string,
    currentGoal: string,
    previousActions: string[],
  ): Promise<ContextualVisualReasoning> {
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
    const data = await res.json() as { response: string };
    try {
      return JSON.parse(data.response) as ContextualVisualReasoning;
    } catch {
      return {
        taskRelevance: 'info',
        implication: data.response,
        suggestedNextAction: 'Continue with caution; VLM reasoning parse failed.',
        requiresHumanReview: false,
      };
    }
  }
}
