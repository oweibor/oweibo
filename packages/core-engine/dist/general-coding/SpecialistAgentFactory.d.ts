import { BaseAgent } from '../agentic/BaseAgent.js';
import type { IAgentTask, ISecurityContext, AgentRole, FileClassifierRule, AgentMessage } from '@oweibo/core-contracts';
import type { ILLMClient } from '@oweibo/core-contracts';
import type { ISemanticMemoryStore } from '@oweibo/core-contracts';
import type { VaultClient } from '../infrastructure/VaultClient.js';
import type { LangfuseTraceClient, Langfuse } from 'langfuse';
import type { EditPlan } from './ConversationalLoop.js';
import type { GeneralCodingResult } from './GeneralCodingOrchestrator.js';
import type { EditApplicator } from './editing/EditApplicator.js';
import type { VerificationRunner } from './editing/VerificationRunner.js';
import type { TenantRulesLoader } from './FileClassifier.js';
import type { Redis } from 'ioredis';
export declare class RoleWriteBoundaryError extends Error {
    constructor(role: AgentRole, filePath: string);
}
/**
 * SpecialistAgentFactory — enforces tenant spawn budgets and constructs
 * specialist BaseAgent instances with role-scoped memory and Langfuse-sourced
 * system prompts.
 *
 * v9.5.2 fixes:
 *   Gap 1: assertWriteBoundary() enforces ROLE_WRITE_BOUNDARIES before apply().
 *   Gap 2: TenantRulesLoader injected for per-tenant FileClassifier rules.
 *   Gap 3: tokensUsed estimated from accumulated response length in execute().
 *   Gap 5: isRestart flag skips INCR on worker-restart re-dispatch.
 *   Gap 8: Langfuse child span on proposeEdit() call in execute().
 *   Gap 9: loadBudget() uses Redis 60 s cache.
 */
export declare class SpecialistAgentFactory {
    private readonly llm;
    private readonly memory;
    private readonly vault;
    private readonly langfuse;
    private readonly applicator;
    private readonly verifier;
    private readonly redis;
    private readonly tenantRulesLoader;
    /** Gap 9: In-memory + Redis budget cache — 60 s TTL */
    private readonly budgetCache;
    private static readonly BUDGET_CACHE_TTL_MS;
    constructor(llm: ILLMClient, memory: ISemanticMemoryStore, vault: VaultClient, langfuse: Langfuse, applicator: EditApplicator, verifier: VerificationRunner, redis: Redis, tenantRulesLoader: TenantRulesLoader);
    /**
     * loadTenantRulesForClassifier — returns the tenant's FileClassifierRules
     * for use in FileClassifier.classify(filePath, tenantRules).
     * Delegates to TenantRulesLoader which has its own 60 s Redis cache.
     */
    loadTenantRulesForClassifier(tenantId: string): Promise<FileClassifierRule[]>;
    /**
     * spawn — validates the tenant spawn budget, then constructs a specialist
     * BaseAgent with the correct role, memory scope, and system prompt.
     *
     * Gap 5 fix: `isRestart` parameter skips INCR when re-dispatching a node
     * that was already counted before a worker crash. The node-level idempotency
     * key `gc-spawn-node:{taskId}:{nodeId}` (TTL = spawnTtlMs) tracks counting.
     *
     * Throws `RoleNotAllowedError` if the role is not in TenantSpawnBudget.allowedSpecialistRoles.
     * Throws `SpawnBudgetExceededError` if maxConcurrentSpawns is reached.
     * Throws if secCtx does not include 'repo:write'.
     */
    spawn(role: AgentRole, task: IAgentTask, nodeId: string, // Gap 5: needed for idempotency key
    secCtx: ISecurityContext, trace: LangfuseTraceClient, isRestart?: boolean): Promise<SpecialistAgent>;
    /**
     * execute — runs the spawned specialist agent for a single DAG node scope.
     *
     * Gap 1 fix: assertWriteBoundary() validates all proposed file paths against
     *            the role's ROLE_WRITE_BOUNDARIES before EditApplicator.apply().
     * Gap 3 fix: tokensUsed estimated from accumulated LLM response length.
     * Gap 8 fix: Langfuse child span wraps the proposeEdit() call.
     */
    execute(agent: SpecialistAgent, task: IAgentTask, plan: EditPlan, repoMapText: string, projectRules: string, skillsPrefix: string, collectionName: string, secCtx: ISecurityContext, trace: LangfuseTraceClient, sessionId: string, nodeId: string): Promise<GeneralCodingResult>;
    /**
     * assertWriteBoundary — Gap 1 fix.
     * Checks every filePath in the proposal against ROLE_WRITE_BOUNDARIES[role].forbidden.
     * Throws RoleWriteBoundaryError before any disk write if a forbidden path is found.
     */
    private assertWriteBoundary;
    /** Gap 9: loadBudget with 60 s in-memory + Redis cache */
    private loadBudget;
}
/**
 * SpecialistAgent — thin BaseAgent subclass for dynamically-spawned specialists.
 * System prompt is injected at construction time from Langfuse (role-specific).
 * Memory scope is isolated: '{role}:{taskId}'.
 *
 * Gap 7 fix: `agentId` and `memoryScope` declared as `override readonly` properties
 * and assigned directly in the constructor body — replaces the fragile
 * `(this as any)._agentId` pattern that silently failed on private/readonly fields.
 */
export declare class SpecialistAgent extends BaseAgent {
    private readonly specialistSystemPrompt;
    readonly agentId: string;
    readonly memoryScope: string;
    constructor(role: AgentRole, agentId: string, memoryScope: string, specialistSystemPrompt: string, llm: ILLMClient, memory: ISemanticMemoryStore, trace: LangfuseTraceClient, taskId: string, tenantId: string);
    proposeEdit(instruction: string, fileContents: Record<string, string>, repoMapContext: string, onChunk: (chunk: string, fileHint: string) => void): Promise<import('./GeneralCodingAgent.js').EditProposal>;
    process(message: AgentMessage): Promise<AgentMessage>;
}
//# sourceMappingURL=SpecialistAgentFactory.d.ts.map