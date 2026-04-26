"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PolicyEngine = exports.PolicyViolationError = void 0;
const DEFAULT_LIMITS = {
    maxTokensPerTask: 200_000,
    maxTokensPerStage: 50_000,
    maxConcurrentTasks: 5,
    maxSandboxes: 10,
    maxFileSize: 10 * 1024 * 1024,
    allowedWorkspacePrefixes: ['/workspaces/', '/tmp/oweibo-'],
    deniedTools: ['rm-rf-root', 'format-disk'],
    maxRetries: 5,
};
class PolicyViolationError extends Error {
    policyName;
    taskId;
    constructor(policyName, taskId, message) {
        super(`[PolicyEngine:${policyName}] ${message} (task: ${taskId})`);
        this.policyName = policyName;
        this.taskId = taskId;
        this.name = 'PolicyViolationError';
    }
}
exports.PolicyViolationError = PolicyViolationError;
class PolicyEngine {
    limits;
    constructor(limits = {}) {
        this.limits = { ...DEFAULT_LIMITS, ...limits };
    }
    assertTokenBudget(tokensUsed, taskId, stage) {
        if (stage && tokensUsed > this.limits.maxTokensPerStage) {
            throw new PolicyViolationError('token-budget-stage', taskId, `Stage "${stage}" used ${tokensUsed} tokens (limit: ${this.limits.maxTokensPerStage})`);
        }
        if (tokensUsed > this.limits.maxTokensPerTask) {
            throw new PolicyViolationError('token-budget-task', taskId, `Task used ${tokensUsed} tokens (limit: ${this.limits.maxTokensPerTask})`);
        }
    }
    assertWorkspacePath(workspacePath, taskId) {
        const allowed = this.limits.allowedWorkspacePrefixes.some(prefix => workspacePath.startsWith(prefix));
        if (!allowed) {
            throw new PolicyViolationError('workspace-path', taskId, `Unauthorized workspace path: ${workspacePath}`);
        }
    }
    assertToolAllowed(toolName, taskId, secCtx) {
        if (this.limits.deniedTools.includes(toolName)) {
            throw new PolicyViolationError('denied-tool', taskId, `Tool "${toolName}" is on the deny list`);
        }
        // Check tool-specific permissions
        if (toolName.startsWith('git-') && !secCtx.permissions.includes('git:write')) {
            throw new PolicyViolationError('tool-permission', taskId, `Tool "${toolName}" requires git:write permission`);
        }
    }
    assertRetryLimit(retryCount, taskId, stageId) {
        if (retryCount > this.limits.maxRetries) {
            throw new PolicyViolationError('retry-limit', taskId, `Stage "${stageId}" exceeded retry limit (${retryCount} > ${this.limits.maxRetries})`);
        }
    }
    assertFileSize(sizeBytes, filePath, taskId) {
        if (sizeBytes > this.limits.maxFileSize) {
            throw new PolicyViolationError('file-size', taskId, `File "${filePath}" exceeds size limit (${sizeBytes} > ${this.limits.maxFileSize})`);
        }
    }
    assertConcurrency(activeTasks, taskId) {
        if (activeTasks >= this.limits.maxConcurrentTasks) {
            throw new PolicyViolationError('concurrency', taskId, `Maximum concurrent tasks reached (${activeTasks} >= ${this.limits.maxConcurrentTasks})`);
        }
    }
}
exports.PolicyEngine = PolicyEngine;
//# sourceMappingURL=PolicyEngine.js.map