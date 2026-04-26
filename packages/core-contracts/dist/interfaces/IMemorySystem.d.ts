/**
 * IMemorySystem — contracts for the four-tier context-aware memory subsystem.
 *
 * Design goals:
 *   1. Hard tenant isolation. `tenantId` is a mandatory parameter on every
 *      operation. A missing tenantId MUST be a TypeScript compile error, not
 *      a runtime filter that might be forgotten. There is no "global" fallback.
 *   2. Four discrete tiers, each with a clear lifetime and ownership:
 *        Working        — per-turn, in-process; evaporates at turn end
 *        Short-term     — per-session (conversation), TTL'd; Redis
 *        Project        — tenant+project scoped, durable
 *        Semantic       — tenant-scoped vector store, durable
 *   3. Typed memory kinds so the consolidator can extract structured knowledge
 *      from task outcomes, not just embed a single strategy string.
 *   4. Context-aware retrieval: the `assembleContext()` facade returns a
 *      ranked, de-duplicated, budget-aware bundle from all tiers, not a raw
 *      vector dump from one tier.
 *
 * This file is the ONLY place the outside world imports memory types from.
 * Implementations live in @oweibo/core-engine under agentic/memory/.
 */
/**
 * TenantId is an opaque string in the contract layer, but every memory
 * implementation MUST treat it as a hard isolation boundary equivalent to
 * a database. Two tenants never see each other's memories.
 */
export type TenantId = string;
export type ProjectId = string;
export type SessionId = string;
export type TaskId = string;
/**
 * MemoryScope threads the full identity chain through every operation.
 * `projectId` is optional at the contract level because not every action
 * lives inside a project (e.g. a one-off ad-hoc task), but when present
 * it becomes the primary cross-session continuity key.
 */
export interface MemoryScope {
    readonly tenantId: TenantId;
    readonly projectId?: ProjectId;
    readonly sessionId?: SessionId;
    readonly taskId?: TaskId;
}
/**
 * MemoryKind — what *category* of knowledge a memory represents.
 *
 * The consolidator extracts one or more kinds from a completed task; the
 * retriever ranks by relevance *within* the requested kinds. Unlike a free-
 * form tag, kinds are a closed enum so ranking weights can be tuned per kind.
 */
export type MemoryKind = 'user-preference' | 'architectural-decision' | 'decision-rationale' | 'failure-lesson' | 'success-pattern' | 'code-landmark' | 'domain-fact' | 'conversation-summary' | 'project-invariant' | 'open-question' | 'tool-heuristic';
/** Human-readable entry used by retrievers and the agent's prompt assembly. */
export interface MemoryEntry {
    readonly id: string;
    readonly scope: MemoryScope;
    readonly kind: MemoryKind;
    /** One-line summary. This is what gets embedded and what the agent sees. */
    readonly summary: string;
    /** Optional long-form body (decision rationale, full plan, etc.). */
    readonly body?: string;
    /** Structured payload for machine consumers; never rendered to the LLM. */
    readonly detail?: Readonly<Record<string, unknown>>;
    /** 0..1 — importance at write time (consolidator-assigned). */
    readonly importance: number;
    /** ISO timestamp of last reinforcement (updated on recall). */
    readonly createdAt: string;
    readonly updatedAt: string;
    /** Monotonic counter incremented on every successful recall. */
    readonly recallCount: number;
}
/** A retrieved memory with ranking metadata attached. */
export interface RankedMemoryEntry extends MemoryEntry {
    /** Final score after blending all signals; higher is better. */
    readonly score: number;
    /** Individual signal contributions for auditability. */
    readonly scoreBreakdown: {
        readonly semantic: number;
        readonly recency: number;
        readonly importance: number;
        readonly kindBoost: number;
        readonly mmrPenalty: number;
    };
}
/**
 * Per-turn scratchpad. Owned by the orchestrator; not shared across turns.
 * Implementations use an in-process Map; no Redis, no network round-trip.
 */
export interface IWorkingMemory {
    readonly scope: MemoryScope;
    set<T>(key: string, value: T): void;
    get<T>(key: string): T | undefined;
    has(key: string): boolean;
    delete(key: string): void;
    keys(): readonly string[];
    snapshot(): Readonly<Record<string, unknown>>;
    clear(): void;
}
/**
 * Session / conversation buffer. Redis-backed, TTL'd. Stores the recent
 * turns verbatim plus a rolling summary of older turns.
 */
export interface ConversationTurn {
    readonly turnId: string;
    readonly role: 'user' | 'assistant' | 'tool' | 'system';
    readonly content: string;
    readonly tokens?: number;
    readonly at: string;
}
export interface SessionContext {
    readonly sessionId: SessionId;
    readonly tenantId: TenantId;
    readonly projectId?: ProjectId;
    readonly recentTurns: readonly ConversationTurn[];
    readonly rollingSummary: string;
    readonly totalTurns: number;
    readonly lastActiveAt: string;
}
/**
 * Returned from append() so the orchestrator can fold any turns evicted by
 * window trimming into the rolling summary. `droppedTurns` is non-empty only
 * when this append pushed the window past its cap.
 */
export interface AppendResult {
    readonly droppedTurns: readonly ConversationTurn[];
    readonly totalTurns: number;
}
export interface IShortTermMemoryStore {
    append(scope: MemoryScope, turn: ConversationTurn): Promise<AppendResult>;
    load(tenantId: TenantId, sessionId: SessionId): Promise<SessionContext | null>;
    /** Replace the rolling summary after a compression pass. */
    setRollingSummary(tenantId: TenantId, sessionId: SessionId, summary: string, totalTurns: number): Promise<void>;
    /** Bind a session to a project so cross-session continuity can resolve it. */
    bindProject(tenantId: TenantId, sessionId: SessionId, projectId: ProjectId): Promise<void>;
    listSessionsForProject(tenantId: TenantId, projectId: ProjectId, limit?: number): Promise<readonly SessionContext[]>;
}
/**
 * Project — the durable, tenant-scoped bundle that tasks attach to. The
 * agent's answer to "remember my project across sessions" is literally
 * "look up the project, load its invariants and recent sessions."
 */
export interface Project {
    readonly projectId: ProjectId;
    readonly tenantId: TenantId;
    readonly name: string;
    readonly description: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    /** Free-form key→value facts the agent has learned. */
    readonly invariants: Readonly<Record<string, string>>;
    /** Pointers to the most recent N sessions on this project. */
    readonly recentSessions: readonly SessionId[];
    readonly tags: readonly string[];
    /** Optional archive flag; archived projects are excluded from ambient recall. */
    readonly archived: boolean;
}
export interface IProjectRegistry {
    create(tenantId: TenantId, name: string, description: string): Promise<Project>;
    get(tenantId: TenantId, projectId: ProjectId): Promise<Project | null>;
    list(tenantId: TenantId): Promise<readonly Project[]>;
    /**
     * Best-effort resolution of a project from natural-language hints — used
     * when a user says "continue with my todo app" without an explicit id.
     */
    resolveByHint(tenantId: TenantId, hint: string): Promise<Project | null>;
    setInvariant(tenantId: TenantId, projectId: ProjectId, key: string, value: string): Promise<void>;
    touch(tenantId: TenantId, projectId: ProjectId, sessionId: SessionId): Promise<void>;
    archive(tenantId: TenantId, projectId: ProjectId): Promise<void>;
}
export interface SemanticStoreOptions {
    /** Embedding dimension. Locked at collection-create time per tenant. */
    readonly dimension: number;
}
export interface StoreMemoryInput {
    readonly scope: MemoryScope;
    readonly kind: MemoryKind;
    readonly summary: string;
    readonly body?: string;
    readonly detail?: Readonly<Record<string, unknown>>;
    readonly importance: number;
}
export interface RecallQuery {
    readonly tenantId: TenantId;
    readonly query: string;
    /** Optional project scope filter — hides memories from other projects. */
    readonly projectId?: ProjectId;
    /** Only return memories of these kinds. Empty = all kinds. */
    readonly kinds?: readonly MemoryKind[];
    readonly topK?: number;
    /** Whether to reinforce (bump recallCount + updatedAt) on returned memories. */
    readonly reinforce?: boolean;
}
export interface ISemanticMemoryStore {
    store(input: StoreMemoryInput): Promise<MemoryEntry>;
    recall(query: RecallQuery): Promise<readonly RankedMemoryEntry[]>;
    /** Hard delete all memories for a tenant. Used at tenant offboarding. */
    purgeTenant(tenantId: TenantId): Promise<void>;
    /** Hard delete all memories for a single project (without touching the tenant). */
    purgeProject(tenantId: TenantId, projectId: ProjectId): Promise<void>;
}
/** Context bundle returned by assembleContext(), ready to inject into a prompt. */
export interface AssembledContext {
    readonly scope: MemoryScope;
    readonly project: Project | null;
    readonly session: SessionContext | null;
    readonly rankedMemories: readonly RankedMemoryEntry[];
    /** Pre-formatted string suitable for direct prompt injection. */
    readonly promptBlock: string;
    /** Token estimate of `promptBlock` so the caller can enforce a budget. */
    readonly estimatedTokens: number;
}
export interface AssembleContextInput {
    readonly scope: MemoryScope;
    readonly query: string;
    readonly kinds?: readonly MemoryKind[];
    readonly topK?: number;
    /** Soft token budget for `promptBlock`. */
    readonly tokenBudget?: number;
}
export interface IMemoryOrchestrator {
    readonly working: (scope: MemoryScope) => IWorkingMemory;
    assembleContext(input: AssembleContextInput): Promise<AssembledContext>;
    recordTurn(scope: MemoryScope, turn: ConversationTurn): Promise<void>;
    record(input: StoreMemoryInput): Promise<MemoryEntry>;
    /** Called at task end to extract typed memories from the task outcome. */
    consolidate(scope: MemoryScope, outcome: TaskOutcome): Promise<readonly MemoryEntry[]>;
}
/** Structured input for consolidation — intentionally richer than just a plan. */
export interface TaskOutcome {
    readonly taskId: TaskId;
    readonly success: boolean;
    readonly summary: string;
    readonly strategy?: string;
    readonly decisions?: readonly {
        decision: string;
        rationale: string;
    }[];
    readonly failures?: readonly {
        attempt: string;
        reason: string;
    }[];
    readonly filesTouched?: readonly string[];
    readonly preferences?: readonly {
        key: string;
        value: string;
    }[];
    readonly invariants?: readonly {
        key: string;
        value: string;
    }[];
    readonly openQuestions?: readonly string[];
}
//# sourceMappingURL=IMemorySystem.d.ts.map