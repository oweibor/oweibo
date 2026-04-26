import type { Plan, IGoal, ISubGoal } from './Plan.js';

// Channel types are duplicated structurally here to keep core-contracts free of
// cross-package imports (rootDir constraint). channel-contracts re-exports
// these names; the shapes are kept in sync by convention.
export type Platform = 'discord' | 'slack' | 'telegram' | 'irc' | 'matrix' | 'web' | 'cli' | 'api';
export interface ChannelReplyTarget {
  readonly platform: Platform;
  readonly channelId: string;
  readonly threadId?: string;
  readonly userId?: string;
}

// ─── LLM Client ───────────────────────────────────────────────────────────────

/** Canonical LLM generate request used by all engine components. */
export interface ILLMGenerateRequest {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly responseFormat?: 'json' | 'text' | 'embedding';
  readonly temperature?: number;
  readonly maxTokens?: number;
}

/** Alias — used throughout core-engine for brevity */
export type LLMGenerateParams = ILLMGenerateRequest;

/** Returns { output: string } — never { text: string }. */
export interface ILLMGenerateResponse {
  readonly output: string;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  /** Set when prompt came from PromptRegistry (Langfuse) */
  readonly promptVersion?: number;
  readonly durationMs?: number;
  /** Populated when responseFormat === 'embedding' */
  readonly embedding?: number[];
}

/** Alias — used throughout core-engine for brevity */
export type LLMGenerateResult = ILLMGenerateResponse;

export interface ILLMClient {
  generate(req: ILLMGenerateRequest): Promise<ILLMGenerateResponse>;
  stream?(params: { systemPrompt: string; userPrompt: string }): AsyncIterable<string>;
}

// ─── Security ─────────────────────────────────────────────────────────────────

/** ISecurityContext — passed to ToolRegistry.invoke() for permission checking. */
export interface ISecurityContext {
  readonly permissions: readonly string[];
  readonly tenantId?: string;
  readonly userId?: string;
  readonly allowExtensionBridge?: boolean;
  readonly allowPersistentProfile?: boolean;
  readonly allowUserChrome?: boolean;
  /** v9.5.9 — gates `import-cookies`. Default true autonomous / false supervised. */
  readonly allowCookieImport?: boolean;
  /** v9.5.9 — gates `autofill-credentials`. Default true all modes. */
  readonly allowAutofill?: boolean;
  /** v9.5.9 — opt-in for cloud Bright Data backend selection by BrowserSessionRouter. */
  readonly allowBrightData?: boolean;
}

// ─── Tool Registry ────────────────────────────────────────────────────────────

export interface IToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

/**
 * M-2: tokensUsed must be present on both success and error paths so
 * ToolPerformanceTracker and AnomalyDetector can read it without null-checks.
 */
export interface IToolInvocationResult {
  readonly toolName: string;
  readonly status: 'success' | 'error';
  readonly output?: unknown;
  readonly error?: string;
  readonly durationMs: number;
  readonly tokensUsed?: number;
}

export interface IToolRegistry {
  semanticSearch(query: string, topK?: number): Promise<readonly IToolDefinition[]>;
  invoke(name: string, input: unknown, secCtx: ISecurityContext): Promise<IToolInvocationResult>;
}

// ─── Sandbox ──────────────────────────────────────────────────────────────────

export interface ISandboxResourceLimits {
  readonly cpuCores: number;
  readonly memoryMB: number;
  readonly diskMB: number;
  readonly timeoutMs: number;
  readonly networkPolicy: 'none' | 'egress-only-allowlist';
  readonly networkAllowlist?: readonly string[];
}

export interface ISandboxResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly memoryPeakMB: number;
  readonly timedOut: boolean;
}

/**
 * ISandbox — canonical sandbox contract (NEW v6).
 * Implemented by GVisorSandbox (production default).
 * FirecrackerSandbox is DEFERRED — future milestone only.
 * healthCheck() is mandatory — TieredWarmPoolManager calls it unconditionally on release.
 */
export interface ISandbox {
  execute(
    script: string,
    runtime: 'node' | 'python3' | 'bash',
    limits?: Partial<ISandboxResourceLimits>,
  ): Promise<ISandboxResult>;
  bootVM(limits: ISandboxResourceLimits): Promise<void>;
  destroyVM(): Promise<void>;
  /** Runs `echo ok`; returns true only if exit 0 and stdout === 'ok' */
  healthCheck(): Promise<boolean>;
}

// ─── Pipeline Error & Recovery ─────────────────────────────────────────────────

export interface IPipelineError {
  readonly stage: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly errorCode: 'GATE_FAILED' | 'SANDBOX_TIMEOUT' | 'LLM_HALLUCINATION' | 'CIRCUIT_OPEN';
  readonly message: string;
  readonly recoveryStrategy: 'retry' | 'context-reset' | 'architect-replan' | 'human-escalation';
}

export interface IRecoveryAction {
  readonly strategy: string;
  readonly delayMs?: number;
  readonly reason: string;
  readonly promptAugmentation?: string;
}

// ─── Delivery ─────────────────────────────────────────────────────────────────

/** v9.3: extended with 'channel-reply' for social channel delivery. */
export type DeliveryMode = 'download-link' | 'git-push' | 'webhook' | 'channel-reply';

export interface DeliveryConfig {
  readonly mode: DeliveryMode;
  readonly gitRepoUrl?: string;
  readonly gitBranch?: string;
  readonly webhookUrl?: string;
  /**
   * channel-reply (v9.3): where to send replies for channel-originated tasks.
   * Populated by ChannelRouter; stored in DistributedContextStore.
   */
  readonly channelReplyTarget?: ChannelReplyTarget;
}

// ─── Agent Task ───────────────────────────────────────────────────────────────

/**
 * IAgentTask — the canonical task contract.
 * All tasks enter the system as IAgentTask via IntentPipeline — the sole entry point.
 */
export interface IAgentTask {
  readonly id: string;
  readonly goal: IGoal;
  readonly userId?: string;
  readonly context?: string;
  readonly ttlSeconds?: number;
  readonly securityContext?: { readonly permissions: readonly string[] };
  // v5: User Interaction Layer
  readonly sessionId?: string;
  readonly deliveryConfig?: DeliveryConfig;
  /**
   * v9: task mode — set by IntentClarifier, consumed by CognitiveEngine routing.
   * 'factory' is the default when field is absent (backward compat).
   */
  readonly taskMode: 'factory' | 'general-coding';
  /** Required for Qdrant collection namespacing and ISecurityContext authz */
  readonly tenantId: string;
  /**
   * Absolute path to repo root — only valid when taskMode === 'general-coding'.
   * MUST be validated against ISecurityContext before GeneralRepoIndexer touches FS.
   */
  readonly repoPath?: string;
}

export interface IAgentTaskResult {
  readonly taskId: string;
  readonly selectedPlan: Plan;
  readonly subGoals: readonly ISubGoal[];
  readonly recalledMemories: readonly unknown[];
}

// ─── Task Event Types ─────────────────────────────────────────────────────────

/** All events published on TaskEventBus (Redis pub/sub). */
export type TaskEventType =
  | 'task-accepted'
  | 'stage-started'
  | 'stage-completed'
  | 'plan-ready'
  | 'output-ready'
  | 'task-failed'
  | 'edit-proposed'          // v9: streaming diff chunks
  | 'edit-applied'           // v9: edit committed to git
  | 'index-ready'            // v9: repo indexed
  | 'docs-generated'         // v8: DocumentationAgent completed
  | 'agent-challenge'        // swarm: reviewer issued challenge
  | 'conflict-resolved'      // swarm: conflict resolver accepted output
  | 'intervention-applied'   // v5: user redirect applied to swarm
  | 'hitl-required'          // v9: verification loop exhausted — human review needed
  | 'verification-failed'    // v9: tsc/eslint/jest failed after edit
  // ── v9.5: Reactive Orchestrator audit events ──────────────────────────────
  | 'plan-node-dispatched'   // v9.5: a DAG node was assigned to an agent — payload: { nodeId, agentId, files }
  | 'plan-node-complete'     // v9.5: a DAG node finished — may trigger downstream dispatches — payload: { nodeId, status, unlockedNodes }
  | 'plan-amended'           // v9.5: orchestrator replanned mid-flight — payload: { reason, addedNodes, removedNodes, dagBefore, dagAfter }
  | 'synthesis-started'      // v9.5: all nodes complete, SynthesisAgent merging outputs — payload: { nodeCount }
  // ── v9.5.1: Hierarchical specialist spawning ──────────────────────────────
  | 'specialist-spawned'     // v9.5.1: a specialist agent was dynamically spawned for a node
                             //   payload: { nodeId, role, files, reason, spawnedAgentId }
                             //   always emitted BEFORE the corresponding 'plan-node-dispatched'
  // ── §22.26: PromptBudgetEnforcer events ──────────────────────────────────
  | 'cost-estimated'      // §22.26: emitted before every LLM call — payload: { estimatedTokens, estimatedCostUsd, sessionId }
  | 'context-overflow'    // §22.26: assembled prompt exceeded budget even after all trimming — payload: { totalTokens, budget, trimReport }
  // ─────────────────────────────────────────────────────────────────────────
  | 'browser-action'
  | 'browser-session-created'
  | 'browser-session-closed'
  | 'browser-navigated'
  | 'browser-console-entry'
  | 'browser-extension-pairing-required'
  | 'browser-extension-connected'
  | 'browser-stealth-pool-acquired'
  | 'browser-profile-restored'
  | 'browser-backend-auto-selected'  // v9.5.9: BrowserSessionRouter resolved 'auto' backend
  | 'browser-cookies-imported'       // v9.5.9: ImportCookiesAction completed
  | 'browser-hitl-resolved'          // v9.5.9: ExtensionHitlRespondAction resolved a gate
  // ── v10.2: Doc-generator pipeline events ─────────────────────────────────
  | 'codebase-analysis-started'      // v10.2: CodebaseAnalyzer.analyze() began
  | 'codebase-analysis-progress'     // v10.2: payload: { phase, filesProcessed, totalFiles }
  | 'codebase-analysis-complete'     // v10.2: CodebaseAnalyzer finished all 6 phases
  | 'doc-generation-started'         // v10.2: DocGeneratorOrchestrator started rendering
  | 'doc-template-rendered'          // v10.2: payload: { category, fileName }
  | 'doc-generation-complete'        // v10.2: all templates rendered and exported
  | 'doc-generation-warning'         // v10.2: payload: AnalysisWarning
  | (string & {});

// ─── Multi-Agent Swarm (NEW v4) ───────────────────────────────────────────────

/**
 * AgentRole — specialist function of each agent in the swarm.
 * 'orchestrator' is reserved for CognitiveEngine.
 */
export type AgentRole =
  | 'orchestrator'
  | 'architect'
  | 'executor'
  | 'reviewer'
  | 'critic'                       // pre-implementation: validates test quality (CriticGateStage 03b)
  | 'domain-specialist'
  | 'documentation-writer'         // v8: user guide, dev docs, API reference
  | 'general-coder'                // v9: conversational editing for arbitrary repos
  | 'synthesizer'                  // v9.5: merges parallel DAG node outputs into a coherent result
  | 'k8s-specialist'               // v9.5.1: Kubernetes manifests, Helm charts, infra YAML
  | 'db-migration-specialist'      // v9.5.1: database migrations — never touches application code
  | 'security-policy-specialist'   // v9.5.1: OPA Rego, Vault policies, security YAML — app code read-only
  | 'doc-analyzer';                // v10.2: autonomous codebase analysis + documentation generation

/**
 * AgentMessage — typed unit of communication between agents on ScopedEventBus.
 * 'challenge' = genuine disagreement — routed to ConflictResolver before execution.
 */
export interface AgentMessage {
  readonly id: string;                // uuid — correlates challenge/response pairs
  readonly from: string;              // agentId of sender
  readonly to: string | 'broadcast';
  readonly type: 'assign' | 'result' | 'challenge' | 'consensus' | 'escalate';
  readonly payload: unknown;
  readonly traceId: string;           // Langfuse trace id
  readonly timestamp: number;
}

/**
 * IAgent — contract every specialist agent must implement.
 * memoryScope is the Qdrant collection filter key scoped to role+taskId,
 * preventing cross-agent memory contamination.
 */
export interface IAgent {
  readonly agentId: string;
  readonly role: AgentRole;
  readonly memoryScope: string;   // e.g. 'reviewer:task-abc'
  process(message: AgentMessage): Promise<AgentMessage>;
}

// ─── Decision Log ────────────────────────────────────────────────────────────

/**
 * DecisionLog — extended format used by CognitiveEngine and ImmutableAuditLogger.
 * The IPipelineTool.DecisionLog is a simpler subset — this one is the full form.
 */
export interface DecisionLog {
  readonly id:             string;
  readonly timestamp:      number;  // Unix ms
  readonly stage:          string;
  readonly decision:       string;
  readonly rationale:      string;
  readonly requirementRef: string;
  readonly alternatives:   readonly string[];
  readonly rejectedReasons: readonly string[];
  readonly agentRole?:     string;
}

// ─── v9.5.1: Dynamic specialist spawning contracts ───────────────────────────

/**
 * TenantSpawnBudget — per-tenant limits on dynamic specialist agent spawning.
 * Loaded from Vault at oweibo/tenants/{tenantId}/spawn-budget.
 * Enforced by SpecialistAgentFactory.assertWithinBudget() via Redis counter.
 *
 * Defaults (applied when the Vault key is absent — safe for tenants that
 * haven't been explicitly configured):
 *   maxConcurrentSpawns: 3
 *   spawnTtlMs:          300_000   (5 minutes)
 *   allowedSpecialistRoles: all specialist roles
 */
export interface TenantSpawnBudget {
  maxConcurrentSpawns: number;
  spawnTtlMs: number;
  allowedSpecialistRoles: AgentRole[];
}

/**
 * FileClassifierRule — single classification rule.
 * Rules are evaluated in order; first match wins.
 * Operators may extend the default rule set by publishing additional rules
 * to Vault at oweibo/tenants/{tenantId}/file-classifier-rules (JSON array).
 */
export interface FileClassifierRule {
  /** Glob-style path pattern, e.g. 'migrations/**', 'k8s/**\/*.yaml' */
  pattern: string;
  role: AgentRole;
  /** Human-readable reason emitted in the 'specialist-spawned' event */
  reason: string;
}

// ─── Re-exports ────────────────────────────────────────────────────────────────
export type { Plan, IGoal, ISubGoal };
