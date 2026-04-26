/**
 * PolicyEngine — token budget, workspace, and security policy enforcement (§16d).
 *
 * Enforces operational limits and security policies across all agent operations.
 * Policies are configurable per tenant via Vault.
 */
import type { ISecurityContext } from '@oweibo/core-contracts';
export interface PolicyLimits {
    readonly maxTokensPerTask: number;
    readonly maxTokensPerStage: number;
    readonly maxConcurrentTasks: number;
    readonly maxSandboxes: number;
    readonly maxFileSize: number;
    readonly allowedWorkspacePrefixes: readonly string[];
    readonly deniedTools: readonly string[];
    readonly maxRetries: number;
}
export declare class PolicyViolationError extends Error {
    readonly policyName: string;
    readonly taskId: string;
    constructor(policyName: string, taskId: string, message: string);
}
export declare class PolicyEngine {
    private readonly limits;
    constructor(limits?: Partial<PolicyLimits>);
    assertTokenBudget(tokensUsed: number, taskId: string, stage?: string): void;
    assertWorkspacePath(workspacePath: string, taskId: string): void;
    assertToolAllowed(toolName: string, taskId: string, secCtx: ISecurityContext): void;
    assertRetryLimit(retryCount: number, taskId: string, stageId: string): void;
    assertFileSize(sizeBytes: number, filePath: string, taskId: string): void;
    assertConcurrency(activeTasks: number, taskId: string): void;
}
//# sourceMappingURL=PolicyEngine.d.ts.map