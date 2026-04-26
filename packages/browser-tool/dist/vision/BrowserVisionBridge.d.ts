import type { BrowserVisionResult, IBrowserExecutionContext, ILLMClient } from '@oweibo/core-contracts';
import type { BrowserTool } from '../tool/BrowserTool.js';
import { type VisionLoopTurn } from './VisionPromptBuilder.js';
export interface VisionBridgeOptions {
    maxIterations?: number;
    /** Token budget for all VLM calls in this loop invocation. 0 = unlimited. */
    tokenBudget?: number;
}
export interface LoopSnapshot {
    goal: string;
    history: VisionLoopTurn[];
    earlierSummary: string;
    iterationsDone: number;
}
export declare class BrowserVisionBridge {
    private readonly tool;
    private readonly llm;
    private readonly promptBuilder;
    constructor(tool: BrowserTool, llm: ILLMClient);
    /** Run the vision loop from scratch. */
    runLoop(goal: string, ctx: IBrowserExecutionContext, options?: VisionBridgeOptions): Promise<BrowserVisionResult>;
    /** Resume a previously suspended loop from a LoopSnapshot. */
    resumeLoop(snapshot: LoopSnapshot, ctx: IBrowserExecutionContext, options?: VisionBridgeOptions): Promise<BrowserVisionResult>;
    private _loop;
}
//# sourceMappingURL=BrowserVisionBridge.d.ts.map