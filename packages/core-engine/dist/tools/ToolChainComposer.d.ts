import type { IToolRegistry, ISecurityContext } from '@oweibo/core-contracts';
export interface ToolChainStep {
    toolName: string;
    inputMapping: Record<string, string | {
        from: string;
        path: string;
    }>;
}
export interface ToolChainResult {
    steps: Array<{
        stepId: string;
        toolName: string;
        output: unknown;
        durationMs: number;
    }>;
    finalOutput: unknown;
    totalDurationMs: number;
}
export declare class ToolChainError extends Error {
    readonly stepId: string;
    readonly toolName: string;
    constructor(stepId: string, toolName: string, detail: string);
}
export declare class ToolChainComposer {
    private readonly registry;
    constructor(registry: IToolRegistry);
    execute(steps: ToolChainStep[], initialContext: Record<string, unknown>, secCtx: ISecurityContext): Promise<ToolChainResult>;
    private resolveInput;
    private dotPath;
}
//# sourceMappingURL=ToolChainComposer.d.ts.map