export interface VisionLoopTurn {
    screenshotBase64: string;
    interpretation: string;
    actionTaken?: string;
}
export interface VisionPromptInput {
    goal: string;
    iteration: number;
    maxIterations: number;
    history: VisionLoopTurn[];
    /** Compressed summary of early history produced by summariseHistory(). */
    earlierSummary?: string;
}
export declare class VisionPromptBuilder {
    static readonly SYSTEM_PROMPT: string;
    buildUserPrompt(input: VisionPromptInput): string;
    /** Produce a compact summary of many history turns for the `earlierSummary` field. */
    summariseHistory(history: VisionLoopTurn[]): string;
}
//# sourceMappingURL=VisionPromptBuilder.d.ts.map