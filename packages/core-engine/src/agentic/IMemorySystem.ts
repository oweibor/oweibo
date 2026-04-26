/**
 * IMemorySystem — unified facade over LTM, STM, warming, and compression.
 *
 * @deprecated **Use `IMemoryOrchestrator` from `@oweibo/core-contracts` instead.**
 *
 * This interface is the legacy memory façade. It has been superseded by the
 * four-tier `IMemoryOrchestrator` contract which models Working / Short-Term /
 * Project / Semantic memory as discrete tiers with hard tenant isolation,
 * typed `MemoryKind` values, and a budget-aware `assembleContext()` facade.
 *
 * Migration:
 *   • Existing code can keep working unchanged by wrapping a `MemoryOrchestrator`
 *     in `LegacyMemorySystemAdapter` (in `agentic/memory/LegacyMemorySystemAdapter.ts`)
 *     and injecting that as the `IMemorySystem`. The adapter translates shapes
 *     and routes both writes and reads through the new orchestrator's tiers.
 *   • New code should depend on `IMemoryOrchestrator` directly. See
 *     `packages/core-engine/src/agentic/memory/MIGRATION.md` for the full
 *     mapping of old → new methods, kinds, and scopes.
 *   • Once all consumers have migrated, this file and `UnifiedMemorySystem`
 *     can be deleted in a single follow-up PR.
 *
 * UnifiedMemorySystem.endSession() is the crash-recovery path (R-4):
 *   1. Check for an existing LTM session entry — skip write if already present
 *      (idempotent: safe to call multiple times, e.g. after a retry).
 *   2. Compress STM via STMCompressor and write to LTM at scope 'session:{id}'.
 *   3. stm.destroySession() is always called in `finally` — not after the catch —
 *      so Redis session keys are torn down regardless of whether the LTM write
 *      succeeded or threw.
 *
 * recall() deduplicates by entry.summary fingerprint (R-10 fix) before returning,
 * using the same logic as MemoryWarmer so callers never see duplicate entries
 * regardless of which channel a memory was surfaced through.
 */

import type {
  LongTermMemoryStore,
  MemoryEntry,
  MemoryTier,
  MemoryType,
  RecallResult,
} from './LongTermMemoryStore.js';
import type { ShortTermMemoryStore, STMEntry } from './ShortTermMemoryStore.js';
import type { MemoryWarmer, WarmResult } from './MemoryWarmer.js';
import type { STMCompressor } from './STMCompressor.js';
import type { Logger } from './MemoryDecayService.js';

// ─── Interface ────────────────────────────────────────────────────────────────

/** Input shape for IMemorySystem.store() — sessionId added to route the STM write. */
type NewMemoryWithSession = Omit<
  MemoryEntry,
  'id' | 'successCount' | 'missCount' | 'confidence' | 'createdAt' | 'lastAccessedAt' | 'lastReinforcedAt'
> & { sessionId: string };

/**
 * @deprecated Use `IMemoryOrchestrator` from `@oweibo/core-contracts`.
 * Wrap an orchestrator in `LegacyMemorySystemAdapter` if you need this surface.
 */
export interface IMemorySystem {
  store(entry: NewMemoryWithSession): Promise<string>;

  recall(params: {
    tenantId:   string;
    sessionId:  string;
    query:      string;
    topK?:      number;
    minScore?:  number;
    tiers?:     MemoryTier[];
    types?:     MemoryType[];
  }): Promise<RecallResult[]>;

  warmForTask(params: Parameters<MemoryWarmer['warmForTask']>[0]): Promise<WarmResult[]>;

  endSession(tenantId: string, sessionId: string): Promise<void>;

  reinforceMemory(memoryId: string, tenantId: string): Promise<void>;

  penaliseMemory(memoryId: string, tenantId: string): Promise<void>;
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * @deprecated Construct a `MemoryOrchestrator` (from `agentic/memory/`) and
 * wrap it in `LegacyMemorySystemAdapter` if you need an `IMemorySystem` shape.
 * UnifiedMemorySystem will be removed once all consumers migrate.
 */
export class UnifiedMemorySystem implements IMemorySystem {
  constructor(
    private readonly ltm:        LongTermMemoryStore,
    private readonly stm:        ShortTermMemoryStore,
    private readonly warmer:     MemoryWarmer,
    private readonly compressor: STMCompressor,
    private readonly logger:     Logger,
  ) {}

  // ── store ─────────────────────────────────────────────────────────────────

  /**
   * store — write to both STM and LTM.
   *
   * STM receives the full entry including sessionId.
   * LTM receives the entry without sessionId (not part of MemoryEntry shape).
   * Returns the STM id so callers have a short-lived handle for the turn.
   */
  async store(entry: NewMemoryWithSession): Promise<string> {
    const { sessionId, ...ltmEntry } = entry;

    // STM write — turn-scoped, expires with the session.
    const stmId = await this.stm.store({
      ...ltmEntry,
      sessionId,
      turnIndex: 0,  // callers that need accurate turn indices should set this field
    });

    // LTM write — persistent, scoped by entry.scope.
    // Fire-and-forget is intentional: STM is the primary store for the current
    // turn; LTM persistence failure should not surface to the caller.
    void this.ltm.store(ltmEntry).catch((err: unknown) => {
      this.logger.warn('[UnifiedMemorySystem] LTM store failed (non-fatal)', {
        scope: entry.scope,
        error: (err as Error).message,
      });
    });

    return stmId;
  }

  // ── recall ────────────────────────────────────────────────────────────────

  /**
   * recall — query both LTM and STM, merge, deduplicate, and sort.
   *
   * STM entries are wrapped as RecallResult with a fixed score of 0.90
   * (same STM_SCALE + STM_OFFSET + STM_BOOST composite used in MemoryWarmer)
   * so they sort consistently against LTM composite scores.
   *
   * R-10 fix: deduplication by entry.summary so promoted copies from multiple
   * channels never appear twice in the result set.
   */
  async recall(params: {
    tenantId:   string;
    sessionId:  string;
    query:      string;
    topK?:      number;
    minScore?:  number;
    tiers?:     MemoryTier[];
    types?:     MemoryType[];
  }): Promise<RecallResult[]> {
    const { tenantId, sessionId, query, topK = 5, minScore = 0, tiers, types } = params;

    const [ltmResults, stmEntries] = await Promise.all([
      this.ltm.recall(tenantId, query, { topK, minScore, tiers, types }),
      this.stm.recall({ tenantId, sessionId, query, topK }),
    ]);

    // Wrap STM entries as RecallResult so they can be merged and sorted with LTM results.
    // Score mirrors the MemoryWarmer composite: 0.60×1.0 + 0.25 + 0.05 = 0.90.
    const STM_SCORE = 0.90;
    const stmResults: RecallResult[] = stmEntries.map(entry => ({
      // STMEntry is structurally compatible with MemoryEntry for the summary field
      // used in deduplication; cast to satisfy RecallResult.entry type.
      entry: entry as unknown as MemoryEntry,
      score: STM_SCORE,
    }));

    // Merge and sort descending before deduplication so the highest-scored copy wins.
    const merged = [...ltmResults, ...stmResults]
      .sort((a, b) => b.score - a.score);

    // R-10: deduplicate by entry.summary fingerprint.
    const seen    = new Set<string>();
    const deduped = merged.filter(r => {
      if (seen.has(r.entry.summary)) return false;
      seen.add(r.entry.summary);
      return true;
    });

    return deduped
      .filter(r => r.score >= minScore)
      .slice(0, topK);
  }

  // ── warmForTask ───────────────────────────────────────────────────────────

  /** Delegate directly to MemoryWarmer. */
  warmForTask(params: Parameters<MemoryWarmer['warmForTask']>[0]): Promise<WarmResult[]> {
    return this.warmer.warmForTask(params);
  }

  // ── endSession ────────────────────────────────────────────────────────────

  /**
   * endSession — crash-recovery LTM write + STM teardown (R-4).
   *
   * Idempotency check: if an LTM entry at scope 'session:{sessionId}' already
   * exists (written by a previous endSession call or a graceful task completion),
   * the compression + LTM write is skipped.
   *
   * stm.destroySession() is in finally — it runs regardless of whether the LTM
   * write succeeded or threw. If destroySession fails, the error is logged and
   * swallowed; Redis TTL will expire the keys naturally.
   */
  async endSession(tenantId: string, sessionId: string): Promise<void> {
    const sessionScope = `session:${sessionId}`;

    try {
      // 1. Idempotency check — skip if crash-recovery entry already exists.
      const existing = await this.ltm.recall(tenantId, sessionScope, {
        scope: sessionScope,
        topK:  1,
      });
      if (existing.length > 0) {
        this.logger.debug('[UnifiedMemorySystem] endSession: session already written to LTM — skipping', {
          tenantId, sessionId,
        });
        return;
      }

      // 2. Compress STM and write crash-recovery entry to LTM.
      const recent   = this.stm.recallRecent({ tenantId, sessionId, limit: 500 });
      const { summary, detail } = this.compressor.compressEntries(recent);

      await this.ltm.store({
        tenantId,
        scope:         sessionScope,
        tier:          'episodic',
        type:          'tool-heuristic',
        summary,
        detail,
        relevanceTags: ['crash-recovery', sessionId],
      });

      this.logger.debug('[UnifiedMemorySystem] endSession: crash-recovery entry written', {
        tenantId, sessionId, summaryLength: summary.length,
      });
    } catch (err) {
      // R-4: the crash-recovery path must never throw — a failed session write
      // is a minor data-loss event, not a reason to surface an error to the caller.
      this.logger.warn('[UnifiedMemorySystem] endSession: LTM write failed (non-fatal)', {
        tenantId, sessionId, error: (err as Error).message,
      });
    } finally {
      // Always tear down STM — Redis keys must not linger regardless of outcome.
      try {
        await this.stm.destroySession(tenantId, sessionId);
      } catch (err) {
        this.logger.warn('[UnifiedMemorySystem] endSession: destroySession failed', {
          tenantId, sessionId, error: (err as Error).message,
        });
      }
    }
  }

  // ── reinforceMemory / penaliseMemory ──────────────────────────────────────

  reinforceMemory(memoryId: string, tenantId: string): Promise<void> {
    return this.ltm.reinforce(memoryId, tenantId);
  }

  penaliseMemory(memoryId: string, tenantId: string): Promise<void> {
    return this.ltm.penalise(memoryId, tenantId);
  }
}
