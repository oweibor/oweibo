/**
 * MemoryOrchestrator — facade that implements IMemoryOrchestrator over the
 * four-tier contract. It owns no storage of its own; every operation routes
 * to one of the injected tiers:
 *
 *   working   → WorkingMemoryRegistry           (tier 1, in-process)
 *   shortTerm → IShortTermMemoryStore           (tier 2, Redis)
 *   projects  → IProjectRegistry                (tier 3, Redis)
 *   semantic  → ISemanticMemoryStore (optional) (tier 4, vector store)
 *
 * The semantic tier is intentionally optional: the contract is usable today
 * with only tiers 1–3 wired up, and `assembleContext` / `record` / `consolidate`
 * degrade gracefully when no vector store is available — calls that would
 * require it return synthesized entries (so the contract still holds) but no
 * vector write actually happens. When a real ISemanticMemoryStore is later
 * supplied (either a native implementation or an adapter over the legacy
 * LongTermMemoryStore) no caller code needs to change.
 *
 * record() routes by kind before falling back to the semantic tier, so the
 * naturally durable kinds land in their proper home:
 *   project-invariant   → ProjectRegistry.setInvariant
 *   conversation-summary → ShortTermMemoryStore.setRollingSummary
 *   everything else     → semantic store, or synthesized if absent.
 */

import { randomUUID } from 'node:crypto';

import type {
  AssembleContextInput,
  AssembledContext,
  ConversationTurn,
  IMemoryOrchestrator,
  IProjectRegistry,
  ISemanticMemoryStore,
  IShortTermMemoryStore,
  IWorkingMemory,
  MemoryEntry,
  MemoryKind,
  MemoryScope,
  Project,
  RankedMemoryEntry,
  SessionContext,
  StoreMemoryInput,
  TaskOutcome,
} from '@oweibo/core-contracts';

import { WorkingMemoryRegistry } from './WorkingMemory.js';

/**
 * Summarizer fold the orchestrator calls when STM evicts turns from its
 * sliding window. Receives the previous rolling summary and the just-evicted
 * turns; returns the new rolling summary. Without this hook STM would drop
 * evicted turns silently and the rolling summary would drift out of sync.
 */
export type ConversationSummarizer = (input: {
  readonly previousSummary: string;
  readonly droppedTurns:    readonly ConversationTurn[];
}) => Promise<string>;

export interface MemoryOrchestratorDeps {
  readonly working:   WorkingMemoryRegistry;
  readonly shortTerm: IShortTermMemoryStore;
  readonly projects:  IProjectRegistry;
  /** Optional — when absent, semantic-tier writes/recalls degrade gracefully. */
  readonly semantic?: ISemanticMemoryStore;
  /** Optional — when absent, evicted turns are dropped without summarization. */
  readonly summarizer?: ConversationSummarizer;
}

const DEFAULT_TOP_K          = 6;
const DEFAULT_TOKEN_BUDGET   = 1500;
const APPROX_CHARS_PER_TOKEN = 4;
const RECENT_TURNS_IN_PROMPT = 6;

export class MemoryOrchestrator implements IMemoryOrchestrator {
  constructor(private readonly deps: MemoryOrchestratorDeps) {}

  readonly working = (scope: MemoryScope): IWorkingMemory => this.deps.working.for(scope);

  // ── assembleContext ──────────────────────────────────────────────────────

  async assembleContext(input: AssembleContextInput): Promise<AssembledContext> {
    const {
      scope, query, kinds,
      topK        = DEFAULT_TOP_K,
      tokenBudget = DEFAULT_TOKEN_BUDGET,
    } = input;
    if (!scope.tenantId) throw new Error('assembleContext: scope.tenantId is required');

    const [project, session, rankedMemories] = await Promise.all([
      scope.projectId
        ? this.deps.projects.get(scope.tenantId, scope.projectId)
        : Promise.resolve<Project | null>(null),
      scope.sessionId
        ? this.deps.shortTerm.load(scope.tenantId, scope.sessionId)
        : Promise.resolve<SessionContext | null>(null),
      this.recall(scope, query, kinds, topK),
    ]);

    const promptBlock = this.formatPromptBlock(project, session, rankedMemories, tokenBudget);
    return {
      scope,
      project,
      session,
      rankedMemories,
      promptBlock,
      estimatedTokens: estimateTokens(promptBlock),
    };
  }

  // ── recordTurn ───────────────────────────────────────────────────────────

  async recordTurn(scope: MemoryScope, turn: ConversationTurn): Promise<void> {
    if (!scope.sessionId) throw new Error('recordTurn: scope.sessionId is required');
    const { droppedTurns, totalTurns } = await this.deps.shortTerm.append(scope, turn);
    if (scope.projectId) {
      await this.deps.projects.touch(scope.tenantId, scope.projectId, scope.sessionId);
    }
    // Fold any window-evicted turns into the rolling summary. No summarizer →
    // accept the loss (matches pre-orchestrator behaviour); with one wired,
    // the summary stays in sync with everything that ever entered the session.
    if (droppedTurns.length && this.deps.summarizer) {
      const session = await this.deps.shortTerm.load(scope.tenantId, scope.sessionId);
      const newSummary = await this.deps.summarizer({
        previousSummary: session?.rollingSummary ?? '',
        droppedTurns,
      });
      await this.deps.shortTerm.setRollingSummary(
        scope.tenantId, scope.sessionId, newSummary, totalTurns,
      );
    }
  }

  // ── record ───────────────────────────────────────────────────────────────

  async record(input: StoreMemoryInput): Promise<MemoryEntry> {
    if (!input.scope.tenantId) throw new Error('record: scope.tenantId is required');

    // Route naturally-durable kinds to their proper home before semantic.
    if (input.kind === 'project-invariant' && input.scope.projectId) {
      const key = pickString(input.detail, 'key') ?? input.summary;
      await this.deps.projects.setInvariant(
        input.scope.tenantId, input.scope.projectId, key, input.body ?? input.summary,
      );
      return synthesizeEntry(input);
    }
    if (input.kind === 'conversation-summary' && input.scope.sessionId) {
      const totalTurns = pickNumber(input.detail, 'totalTurns') ?? 0;
      await this.deps.shortTerm.setRollingSummary(
        input.scope.tenantId, input.scope.sessionId,
        input.body ?? input.summary, totalTurns,
      );
      return synthesizeEntry(input);
    }
    if (this.deps.semantic) return this.deps.semantic.store(input);
    return synthesizeEntry(input);
  }

  // ── consolidate ──────────────────────────────────────────────────────────

  async consolidate(scope: MemoryScope, outcome: TaskOutcome): Promise<readonly MemoryEntry[]> {
    const entries: MemoryEntry[] = [];
    const baseImportance = outcome.success ? 0.6 : 0.5;

    if (outcome.summary) {
      entries.push(await this.record({
        scope,
        kind:       outcome.success ? 'success-pattern' : 'failure-lesson',
        summary:    outcome.summary,
        body:       outcome.strategy,
        detail:     { taskId: outcome.taskId },
        importance: baseImportance,
      }));
    }
    for (const d of outcome.decisions ?? []) {
      entries.push(await this.record({
        scope, kind: 'decision-rationale',
        summary: d.decision, body: d.rationale, importance: baseImportance,
      }));
    }
    for (const f of outcome.failures ?? []) {
      entries.push(await this.record({
        scope, kind: 'failure-lesson',
        summary: f.attempt, body: f.reason, importance: 0.7,
      }));
    }
    for (const inv of outcome.invariants ?? []) {
      entries.push(await this.record({
        scope, kind: 'project-invariant',
        summary: `${inv.key} = ${inv.value}`,
        body:    inv.value,
        detail:  { key: inv.key },
        importance: 0.8,
      }));
    }
    for (const pref of outcome.preferences ?? []) {
      entries.push(await this.record({
        scope, kind: 'user-preference',
        summary: `${pref.key} = ${pref.value}`,
        body:    pref.value,
        detail:  { key: pref.key },
        importance: 0.7,
      }));
    }
    for (const q of outcome.openQuestions ?? []) {
      entries.push(await this.record({
        scope, kind: 'open-question', summary: q, importance: 0.4,
      }));
    }
    if (outcome.filesTouched?.length) {
      entries.push(await this.record({
        scope, kind: 'code-landmark',
        summary: `task ${outcome.taskId} touched ${outcome.filesTouched.length} files`,
        detail:  { files: outcome.filesTouched },
        importance: 0.3,
      }));
    }
    return entries;
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async recall(
    scope: MemoryScope,
    query: string,
    kinds: readonly MemoryKind[] | undefined,
    topK: number,
  ): Promise<readonly RankedMemoryEntry[]> {
    if (!this.deps.semantic) return [];
    return this.deps.semantic.recall({
      tenantId:  scope.tenantId,
      query,
      projectId: scope.projectId,
      kinds,
      topK,
      reinforce: true,
    });
  }

  private formatPromptBlock(
    project:  Project | null,
    session:  SessionContext | null,
    ranked:   readonly RankedMemoryEntry[],
    tokenBudget: number,
  ): string {
    const sections: string[] = [];

    if (project) {
      const invariantLines = Object.entries(project.invariants).map(([k, v]) => `  - ${k}: ${v}`);
      const tagLine = project.tags.length ? `  tags: ${project.tags.join(', ')}` : '';
      sections.push([
        `# Project: ${project.name}`,
        project.description ? `  ${project.description}` : '',
        invariantLines.length ? `Invariants:\n${invariantLines.join('\n')}` : '',
        tagLine,
      ].filter(Boolean).join('\n'));
    }

    if (session) {
      if (session.rollingSummary) {
        sections.push(`# Conversation summary\n${session.rollingSummary}`);
      }
      if (session.recentTurns.length) {
        const turnLines = session.recentTurns
          .slice(-RECENT_TURNS_IN_PROMPT)
          .map((t) => `  ${t.role}: ${oneLine(t.content, 240)}`);
        sections.push(`# Recent turns\n${turnLines.join('\n')}`);
      }
    }

    if (ranked.length) {
      const memLines = ranked.map((m) => `  - [${m.kind}] ${oneLine(m.summary, 200)}`);
      sections.push(`# Relevant memories\n${memLines.join('\n')}`);
    }

    return enforceBudget(sections.join('\n\n'), tokenBudget);
  }
}

// ── module-private utilities ────────────────────────────────────────────────

function synthesizeEntry(input: StoreMemoryInput): MemoryEntry {
  const now = new Date().toISOString();
  return {
    id:          randomUUID(),
    scope:       input.scope,
    kind:        input.kind,
    summary:     input.summary,
    body:        input.body,
    detail:      input.detail,
    importance:  input.importance,
    createdAt:   now,
    updatedAt:   now,
    recallCount: 0,
  };
}

function pickString(detail: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const v = detail?.[key];
  return typeof v === 'string' ? v : undefined;
}

function pickNumber(detail: Readonly<Record<string, unknown>> | undefined, key: string): number | undefined {
  const v = detail?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / APPROX_CHARS_PER_TOKEN);
}

function enforceBudget(s: string, tokenBudget: number): string {
  if (estimateTokens(s) <= tokenBudget) return s;
  const maxChars = tokenBudget * APPROX_CHARS_PER_TOKEN;
  return s.slice(0, Math.max(0, maxChars - 16)) + '\n…[truncated]';
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}
