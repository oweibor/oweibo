export interface VLMAnalysis {
    description: string;
    uiElements: Array<{
        selector: string;
        type: string;
        label: string;
    }>;
    actionSuggestions: Array<{
        action: 'click' | 'type' | 'scroll';
        target: string;
        value?: string;
    }>;
    errorDetected: boolean;
    errorMessage?: string;
}
export interface ContextualVisualReasoning {
    taskRelevance: 'blocker' | 'warning' | 'info' | 'success';
    implication: string;
    suggestedNextAction: string;
    requiresHumanReview: boolean;
}
export declare class OllamaVLMClient {
    private readonly baseUrl;
    private readonly model;
    constructor(baseUrl?: string, model?: string);
    analyzeScreenshot(screenshotBase64: string, prompt: string): Promise<VLMAnalysis>;
    reason(screenshotBase64: string, currentGoal: string, previousActions: string[]): Promise<ContextualVisualReasoning>;
}
//# sourceMappingURL=VLMClient.d.ts.map