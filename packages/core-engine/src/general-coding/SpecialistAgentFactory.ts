// packages/core-engine/src/general-coding/SpecialistAgentFactory.ts
import { BaseAgent } from '../agentic/BaseAgent.js';
import type {
  IAgentTask, ISecurityContext, AgentRole,
  TenantSpawnBudget, FileClassifierRule, AgentMessage,
} from '@oweibo/core-contracts';
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
import { randomUUID } from 'crypto';
import { minimatch } from 'minimatch';

/** Default budget applied when Vault key is absent */
const DEFAULT_BUDGET: TenantSpawnBudget = {
  maxConcurrentSpawns: 3,
  spawnTtlMs: 300_000,
  allowedSpecialistRoles: ['k8s-specialist', 'db-migration-specialist', 'security-policy-specialist', 'synthesizer'],
};

/** Langfuse prompt names per specialist role */
const SPECIALIST_PROMPTS: Record<string, string> = {
  'k8s-specialist':              'general-coding/k8s-specialist-system',
  'db-migration-specialist':     'general-coding/db-migration-specialist-system',
  'security-policy-specialist':  'general-coding/security-policy-specialist-system',
  'synthesizer':                 'general-coding/synthesizer-system',
};

// ── Gap 1 fix: Write-boundary enforcement ─────────────────────────────────────
/**
 * ROLE_WRITE_BOUNDARIES — per-role forbidden path patterns.
 * Any filePath in a proposal that matches a forbidden pattern for the agent's
 * role causes assertWriteBoundary() to throw RoleWriteBoundaryError before
 * EditApplicator.apply() is ever called.
 *
 * Patterns use minimatch glob syntax, evaluated against repo-relative paths.
 */
const ROLE_WRITE_BOUNDARIES: Record<string, { forbidden: string[] }> = {
  'k8s-specialist': {
    forbidden: ['src/**', 'test/**', 'tests/**', '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.go', '**/*.py', '**/*.rb', '**/*.java'],
  },
  'db-migration-specialist': {
    forbidden: ['src/**', 'lib/**', 'app/**', 'test/**', 'tests/**', '**/*.ts', '**/*.tsx', '**/*.js', '**/*.go', '**/*.py', '**/*.rb'],
  },
  'security-policy-specialist': {
    forbidden: ['src/**', 'lib/**', 'app/**', 'test/**', 'tests/**', '**/*.ts', '**/*.tsx', '**/*.js', '**/*.go', '**/*.py', '**/*.rb'],
  },
};

export class RoleWriteBoundaryError extends Error {
  constructor(role: AgentRole, filePath: string) {
    super(`[SpecialistAgentFactory] Role '${role}' attempted to write forbidden path '${filePath}'. Proposal rejected before disk write.`);
    this.name = 'RoleWriteBoundaryError';
  }
}
// ─────────────────────────────────────────────────────────────────────────────

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
export class SpecialistAgentFactory {
  /** Gap 9: In-memory + Redis budget cache — 60 s TTL */
  private readonly budgetCache = new Map<string, { budget: TenantSpawnBudget; expiresAt: number }>();
  private static readonly BUDGET_CACHE_TTL_MS = 60_000;

  constructor(
    private readonly llm:               ILLMClient,
    private readonly memory:            ISemanticMemoryStore,
    private readonly vault:             VaultClient,
    private readonly langfuse:          Langfuse,
    private readonly applicator:        EditApplicator,
    private readonly verifier:          VerificationRunner,
    private readonly redis:             Redis,
    private readonly tenantRulesLoader: TenantRulesLoader,  // Gap 2 fix
  ) {}

  /**
   * loadTenantRulesForClassifier — returns the tenant's FileClassifierRules
   * for use in FileClassifier.classify(filePath, tenantRules).
   * Delegates to TenantRulesLoader which has its own 60 s Redis cache.
   */
  async loadTenantRulesForClassifier(tenantId: string): Promise<FileClassifierRule[]> {
    return this.tenantRulesLoader.load(tenantId);
  }

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
  async spawn(
    role: AgentRole,
    task: IAgentTask,
    nodeId: string,          // Gap 5: needed for idempotency key
    secCtx: ISecurityContext,
    trace: LangfuseTraceClient,
    isRestart: boolean = false,  // Gap 5: true when re-dispatching after worker crash
  ): Promise<SpecialistAgent> {
    if (!secCtx.permissions.includes('repo:write')) {
      throw new Error(`[SpecialistAgentFactory] Tenant ${task.tenantId} lacks repo:write permission`);
    }

    const budget = await this.loadBudget(task.tenantId);

    if (!budget.allowedSpecialistRoles.includes(role)) {
      throw new Error(`[SpecialistAgentFactory] Role '${role}' is not in allowed specialist roles for tenant ${task.tenantId}`);
    }

    const counterKey = `gc-spawn-active:${task.id}`;
    const nodeKey    = `gc-spawn-node:${task.id}:${nodeId}`;  // Gap 5: idempotency key

    if (!isRestart) {
      // Check idempotency key — prevents double-counting if dispatchNode() is
      // called twice for the same node (e.g. a bug, not a restart).
      const alreadyCounted = await this.redis.exists(nodeKey);
      if (!alreadyCounted) {
        const current = await this.redis.incr(counterKey);
        await this.redis.pexpire(counterKey, budget.spawnTtlMs);
        await this.redis.set(nodeKey, '1', 'PX', budget.spawnTtlMs);  // TTL matches spawn TTL

        if (current > budget.maxConcurrentSpawns) {
          // Roll back: this spawn is rejected
          await this.redis.decr(counterKey);
          await this.redis.del(nodeKey);
          throw new Error(
            `[SpecialistAgentFactory] Spawn budget exceeded for task ${task.id}: ` +
            `${current - 1}/${budget.maxConcurrentSpawns} active spawns`
          );
        }
      }
      // If alreadyCounted: node key exists, INCR already happened — skip (idempotent).
    }
    // isRestart === true: skip INCR entirely. Counter may have expired (TTL),
    // so a DECR in execute().finally is still safe (Redis DECR past 0 is non-fatal).

    const promptName = SPECIALIST_PROMPTS[role];
    if (!promptName) throw new Error(`[SpecialistAgentFactory] No Langfuse prompt registered for role '${role}'`);
    const promptObj    = await this.langfuse.getPrompt(promptName, undefined, { label: 'production' });
    const systemPrompt = promptObj.prompt;

    const agentId    = `${role}:${randomUUID().slice(0, 8)}`;
    const memoryScope = `${role}:${task.id}`;

    return new SpecialistAgent(role, agentId, memoryScope, systemPrompt, this.llm, this.memory, trace, task.id, task.tenantId);
  }

  /**
   * execute — runs the spawned specialist agent for a single DAG node scope.
   *
   * Gap 1 fix: assertWriteBoundary() validates all proposed file paths against
   *            the role's ROLE_WRITE_BOUNDARIES before EditApplicator.apply().
   * Gap 3 fix: tokensUsed estimated from accumulated LLM response length.
   * Gap 8 fix: Langfuse child span wraps the proposeEdit() call.
   */
  async execute(
    agent: SpecialistAgent,
    task: IAgentTask,
    plan: EditPlan,
    repoMapText: string,
    projectRules: string,
    skillsPrefix: string,
    collectionName: string,
    secCtx: ISecurityContext,
    trace: LangfuseTraceClient,
    sessionId: string,
    nodeId: string,
  ): Promise<GeneralCodingResult> {
    const counterKey = `gc-spawn-active:${task.id}`;
    try {
      // Read file contents directly from disk (same pattern as ConversationalLoop.readFiles)
      const { readFile } = await import('fs/promises');
      const { join }     = await import('path');
      const fileContents: Record<string, string> = {};
      for (const file of plan.filesToChange) {
        fileContents[file] = await readFile(join(task.repoPath!, file), 'utf8');
      }

      // Gap 8: Langfuse child span for the LLM call.
      // Name includes nodeId so traces are scoped per DAG node, not just per role.
      const proposeSpan = trace.span({
        name:  `specialist-execute:${agent.role}:${nodeId}`,
        input: { files: plan.filesToChange, role: agent.role, nodeId },
      });

      let accumulated = '';
      const proposal = await agent.proposeEdit(
        plan.instruction,
        fileContents,
        repoMapText,
        (chunk, _fileHint) => { accumulated += chunk; },
      );

      // Gap 3: estimate tokens from accumulated response (consistent with ConversationalLoop heuristic)
      const tokensUsed = Math.ceil(accumulated.length / 4);
      proposeSpan.end({ output: { tokensUsed, proposalFiles: proposal.proposal.map(p => p.filePath) } });

      // Gap 1: Enforce write boundaries BEFORE applying to disk
      this.assertWriteBoundary(agent.role as AgentRole, proposal);

      // Apply changes atomically via git — EditApplicator manages sandbox internally
      const { commitHash, editedFiles } = await this.applicator.apply(task.repoPath!, proposal, task.id, sessionId, secCtx);

      const verificationResult = await this.verifier.run(task.repoPath!, editedFiles, secCtx);

      return {
        status:             verificationResult.passed ? 'success' : 'partial',
        appliedEdits:       editedFiles,
        commitHash,
        verificationPassed: verificationResult.passed,
        tokensUsed,  // Gap 3: real value, not 0
      };
    } finally {
      await this.redis.decr(counterKey);
    }
  }

  /**
   * assertWriteBoundary — Gap 1 fix.
   * Checks every filePath in the proposal against ROLE_WRITE_BOUNDARIES[role].forbidden.
   * Throws RoleWriteBoundaryError before any disk write if a forbidden path is found.
   */
  private assertWriteBoundary(role: AgentRole, proposal: import('./GeneralCodingAgent.js').EditProposal): void {
    const boundaries = ROLE_WRITE_BOUNDARIES[role];
    if (!boundaries) return;  // no boundary defined for this role — allow all (general-coder path)

    const allPaths = [
      ...proposal.proposal.map(p => p.filePath),
      ...proposal.newFiles.map(f => f.filePath),
      ...proposal.deletedFiles,
    ];

    for (const filePath of allPaths) {
      for (const forbiddenPattern of boundaries.forbidden) {
        if (minimatch(filePath, forbiddenPattern, { matchBase: true })) {
          throw new RoleWriteBoundaryError(role, filePath);
        }
      }
    }
  }

  /** Gap 9: loadBudget with 60 s in-memory + Redis cache */
  private async loadBudget(tenantId: string): Promise<TenantSpawnBudget> {
    const now    = Date.now();
    const cached = this.budgetCache.get(tenantId);
    if (cached && cached.expiresAt > now) return cached.budget;

    const cacheKey = `spawn-budget:${tenantId}`;
    try {
      const redisVal = await this.redis.get(cacheKey);
      if (redisVal) {
        const budget = JSON.parse(redisVal) as TenantSpawnBudget;
        this.budgetCache.set(tenantId, { budget, expiresAt: now + SpecialistAgentFactory.BUDGET_CACHE_TTL_MS });
        return budget;
      }
    } catch { /* Redis miss — fall through to Vault */ }

    let budget = DEFAULT_BUDGET;
    try {
      const data = await this.vault.read(`oweibo/tenants/${tenantId}/spawn-budget`);
      if (data) {
        const raw = typeof data['value'] === 'string' ? data['value'] : null;
        if (raw) budget = JSON.parse(raw) as TenantSpawnBudget;
      }
    } catch { /* Vault absent — use default */ }

    this.budgetCache.set(tenantId, { budget, expiresAt: now + SpecialistAgentFactory.BUDGET_CACHE_TTL_MS });
    try {
      await this.redis.set(cacheKey, JSON.stringify(budget), 'PX', SpecialistAgentFactory.BUDGET_CACHE_TTL_MS);
    } catch { /* cache write failure is non-fatal */ }

    return budget;
  }
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
export class SpecialistAgent extends BaseAgent {
  // Gap 7: TypeScript override — shadows BaseAgent's auto-generated values
  override readonly agentId: string;
  override readonly memoryScope: string;

  constructor(
    role: AgentRole,
    agentId: string,
    memoryScope: string,
    private readonly specialistSystemPrompt: string,
    llm: ILLMClient,
    memory: ISemanticMemoryStore,
    trace: LangfuseTraceClient,
    taskId: string,
    tenantId: string,
  ) {
    super(role, llm, memory, specialistSystemPrompt, trace, taskId, tenantId);
    // Assign AFTER super() — these are the correct, role-scoped values
    this.agentId     = agentId;
    this.memoryScope = memoryScope;
  }

  async proposeEdit(
    instruction: string,
    fileContents: Record<string, string>,
    repoMapContext: string,
    onChunk: (chunk: string, fileHint: string) => void,
  ): Promise<import('./GeneralCodingAgent.js').EditProposal> {
    const userPrompt = `
Repo context:
${repoMapContext}

Current file contents:
${Object.entries(fileContents).map(([p, c]) => `### ${p}\n\`\`\`\n${c}\n\`\`\``).join('\n\n')}

Instruction: ${instruction}

Produce a unified diff for each file that needs to change. Output JSON only:
{
  "proposal": [{ "filePath": string, "diff": string, "changeDescription": string }],
  "newFiles": [{ "filePath": string, "content": string }],
  "deletedFiles": string[],
  "explanation": string
}
    `.trim();

    let accumulated = '';
    if (this.llm.stream) {
      for await (const chunk of this.llm.stream({ systemPrompt: this.specialistSystemPrompt, userPrompt })) {
        accumulated += chunk;
        const fileHint = chunk.match(/"filePath"\s*:\s*"([^"]+)"/)?.[1] ?? '';
        onChunk(chunk, fileHint);
      }
    } else {
      const res = await this.llm.generate({ systemPrompt: this.specialistSystemPrompt, userPrompt });
      accumulated = res.output;
      onChunk(accumulated, '');
    }
    return JSON.parse(accumulated);
  }

  async process(message: AgentMessage): Promise<AgentMessage> {
    return { ...message, from: this.agentId, type: 'result', payload: null };
  }
}
