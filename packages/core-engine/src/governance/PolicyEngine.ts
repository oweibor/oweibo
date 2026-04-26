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

const DEFAULT_LIMITS: PolicyLimits = {
  maxTokensPerTask: 200_000,
  maxTokensPerStage: 50_000,
  maxConcurrentTasks: 5,
  maxSandboxes: 10,
  maxFileSize: 10 * 1024 * 1024,
  allowedWorkspacePrefixes: ['/workspaces/', '/tmp/oweibo-'],
  deniedTools: ['rm-rf-root', 'format-disk'],
  maxRetries: 5,
};

export class PolicyViolationError extends Error {
  constructor(
    public readonly policyName: string,
    public readonly taskId: string,
    message: string,
  ) {
    super(`[PolicyEngine:${policyName}] ${message} (task: ${taskId})`);
    this.name = 'PolicyViolationError';
  }
}

export class PolicyEngine {
  private readonly limits: PolicyLimits;

  constructor(limits: Partial<PolicyLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  assertTokenBudget(tokensUsed: number, taskId: string, stage?: string): void {
    if (stage && tokensUsed > this.limits.maxTokensPerStage) {
      throw new PolicyViolationError(
        'token-budget-stage', taskId,
        `Stage "${stage}" used ${tokensUsed} tokens (limit: ${this.limits.maxTokensPerStage})`,
      );
    }
    if (tokensUsed > this.limits.maxTokensPerTask) {
      throw new PolicyViolationError(
        'token-budget-task', taskId,
        `Task used ${tokensUsed} tokens (limit: ${this.limits.maxTokensPerTask})`,
      );
    }
  }

  assertWorkspacePath(workspacePath: string, taskId: string): void {
    const allowed = this.limits.allowedWorkspacePrefixes.some(
      prefix => workspacePath.startsWith(prefix),
    );
    if (!allowed) {
      throw new PolicyViolationError(
        'workspace-path', taskId,
        `Unauthorized workspace path: ${workspacePath}`,
      );
    }
  }

  assertToolAllowed(toolName: string, taskId: string, secCtx: ISecurityContext): void {
    if (this.limits.deniedTools.includes(toolName)) {
      throw new PolicyViolationError(
        'denied-tool', taskId,
        `Tool "${toolName}" is on the deny list`,
      );
    }

    // Check tool-specific permissions
    if (toolName.startsWith('git-') && !secCtx.permissions.includes('git:write')) {
      throw new PolicyViolationError(
        'tool-permission', taskId,
        `Tool "${toolName}" requires git:write permission`,
      );
    }
  }

  assertRetryLimit(retryCount: number, taskId: string, stageId: string): void {
    if (retryCount > this.limits.maxRetries) {
      throw new PolicyViolationError(
        'retry-limit', taskId,
        `Stage "${stageId}" exceeded retry limit (${retryCount} > ${this.limits.maxRetries})`,
      );
    }
  }

  assertFileSize(sizeBytes: number, filePath: string, taskId: string): void {
    if (sizeBytes > this.limits.maxFileSize) {
      throw new PolicyViolationError(
        'file-size', taskId,
        `File "${filePath}" exceeds size limit (${sizeBytes} > ${this.limits.maxFileSize})`,
      );
    }
  }

  assertConcurrency(activeTasks: number, taskId: string): void {
    if (activeTasks >= this.limits.maxConcurrentTasks) {
      throw new PolicyViolationError(
        'concurrency', taskId,
        `Maximum concurrent tasks reached (${activeTasks} >= ${this.limits.maxConcurrentTasks})`,
      );
    }
  }
}
