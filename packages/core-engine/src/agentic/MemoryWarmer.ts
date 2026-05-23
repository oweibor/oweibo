/**
 * MemoryWarmer — assembles the warm-memory block injected into agent system prompts.
 *
 * Fires four parallel recall channels and merges them into a single ranked list:
 *   1. LTM agent scope  — memories specific to this agent role + task
 *   2. LTM project scope — project-level conventions and decisions (when projectId supplied)
 *   3. STM in-session   — recent turns from the warm Redis VSS layer
 *   4. LTM tenant scope — promoted tenant-wide procedural knowledge
 *
 * Score normalisation ensures LTM composite scores (0–1.3+) and STM raw cosine
 * scores (0–1) are brought onto a comparable scale before merging:
 *
 *   LTM agent:   score = r.score + AGENT_BOOST   (0.10 proximity bonus)
 *   LTM project: score = r.score + PROJECT_BOOST (0.08 proximity bonus)
 *   LTM tenant:  score = r.score                 (baseline — no boost)
 *   STM:         score = STM_SCALE × cosine + STM_OFFSET + STM_BOOST
 *                      = 0.60 × 1.0 + 0.25 + 0.05 = 0.90 (default)
 *
 * STM entries from the recall channel do not expose their KNN score, so
 * cosineScore defaults to 1.0 — all returned STM entries passed the KNN
 * filter and are treated as fully relevant; recency credit comes from
 * STM_OFFSET and role specificity from STM_BOOST.
 *
 * Deduplication: by entry.summary string equality — not by entry.id.
 * The same semantic memory can appear in multiple channels (e.g. agent scope
 * and tenant scope after MemoryScopePromoter runs); ids diverge between the
 * original and promoted copy but summaries match.
 *
 * Token truncation is NOT performed here — that is PromptBudgetEnforcer's job.
 *
 * Phase 2b: Migrated from legacy LongTermMemoryStore to ISemanticMemoryStore.
 */

import type {
  ISemanticMemoryStore,
  RankedMemoryEntry,
  IPlatformLessonRecall,
  PlatformLessonHit,
} from '@oweibo/core-contracts';
import type { ShortTermMemoryStore, STMEntry } from './ShortTermMemoryStore.js';
import { isSuppressedSeedTagged, isRetiredSeedTagged } from './memory/seedTags.js';

// ─── Score normalisation constants ────────────────────────────────────────────
// These are fixed scale factors, not config — changing them requires understanding
// the composite scoring formula in QdrantSemanticStore.recall().

const AGENT_BOOST   = 0.10;
const PROJECT_BOOST = 0.08;
const STM_BOOST     = 0.05;
const STM_SCALE     = 0.60;  // maps cosine [0,1] onto the LTM composite range
const STM_OFFSET    = 0.25;  // recency credit for in-session entries
// T.4: platform-lesson channel — intentionally below the agent boost so any
// organic memory the tenant has accumulated outranks generic platform
// guidance once present.
const PLATFORM_LESSON_SCALE  = 0.55;
const PLATFORM_LESSON_OFFSET = 0.10;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WarmResult {
  entry:  RankedMemoryEntry | STMEntry | PlatformLessonEntry;
  score:  number;
  source: 'ltm' | 'stm' | 'platform';
}

/**
 * T.4: a platform-lesson hit reshaped for the WarmResult union. The
 * MemoryWarmer never re-attributes the lesson to a tenant; the [platform]
 * marker is added downstream in prompt assembly.
 */
export interface PlatformLessonEntry {
  readonly id: string;
  readonly summary: string;
  readonly body?: string;
  /** Tagged so the suppression filter still treats it like any other entry. */
  readonly tags: readonly string[];
  readonly source: 'platform-lesson';
}

// ─── Warmer ───────────────────────────────────────────────────────────────────

export class MemoryWarmer {
  constructor(
    private readonly ltm: ISemanticMemoryStore,
    private readonly stm: ShortTermMemoryStore,
    /** T.4: optional fifth channel; omit to preserve four-channel behavior. */
    private readonly platformLessons?: IPlatformLessonRecall,
  ) {}

  /**
   * warmForTask — assemble the warm-memory block for a task.
   *
   * @param tenantId        — tenant for Qdrant collection scoping
   * @param sessionId       — STM session to recall from
   * @param agentScope      — '{role}:{taskId}' — unused in contract API (kept for compat)
   * @param taskDescription — query text for all four recall channels
   * @param projectId       — optional project; enables the project scope channel
   * @param topK            — entries per channel AND final slice (default: 6)
   */
  async warmForTask(params: {
    tenantId:        string;
    sessionId:       string;
    agentScope:      string;
    taskDescription: string;
    projectId?:      string;
    maxTokens?:      number;  // reserved for PromptBudgetEnforcer — unused here
    topK?:           number;
  }): Promise<WarmResult[]> {
    const {
      tenantId,
      sessionId,
      taskDescription,
      projectId,
      topK = 6,
    } = params;

    // ── Four parallel recall channels ─────────────────────────────────────────
    // The contract-based ISemanticMemoryStore.recall() accepts a RecallQuery.
    // Agent-scope and tenant-scope are differentiated by projectId filter;
    // the QdrantSemanticStore returns composite-scored RankedMemoryEntry[].
    const [agentResults, projectResults, stmResults, tenantResults, platformResults] = await Promise.all([
      // Channel 1: task-execution kinds — lessons learned and patterns that guide the current work
      this.ltm.recall({
        tenantId, query: taskDescription, topK,
        kinds: ['failure-lesson', 'success-pattern', 'tool-heuristic', 'decision-rationale'],
      }),
      // Channel 2: project-scoped recall
      projectId
        ? this.ltm.recall({ tenantId, query: taskDescription, projectId, topK })
        : Promise.resolve([] as readonly RankedMemoryEntry[]),
      // Channel 3: STM in-session recall
      this.stm.recall({ tenantId, sessionId, query: taskDescription, topK }),
      // Channel 4: ambient knowledge kinds — structural and domain facts promoted tenant-wide
      this.ltm.recall({
        tenantId, query: taskDescription, topK,
        kinds: ['architectural-decision', 'domain-fact', 'code-landmark', 'open-question'],
      }),
      // Channel 5 (T.4): platform-scope cross-tenant lessons. Only fires when the
      // recall service is injected — feature-flagged in the runtime wire. Recall
      // failures degrade silently to an empty channel; never block the warmer.
      this.platformLessons
        ? this.platformLessons.recall({ query: taskDescription, topK }).catch(() => [] as readonly PlatformLessonHit[])
        : Promise.resolve([] as readonly PlatformLessonHit[]),
    ]);

    // ── Map each source to WarmResult[] with normalised scores ────────────────

    const agentWarm: WarmResult[] = agentResults.map(r => ({
      entry:  r,
      score:  r.score + AGENT_BOOST,
      source: 'ltm' as const,
    }));

    const projectWarm: WarmResult[] = projectResults.map(r => ({
      entry:  r,
      score:  r.score + PROJECT_BOOST,
      source: 'ltm' as const,
    }));

    const tenantWarm: WarmResult[] = tenantResults.map(r => ({
      entry:  r,
      score:  r.score,
      source: 'ltm' as const,
    }));

    // STM entries don't expose their KNN score; use cosineScore = 1.0 (all
    // returned entries passed the KNN filter and are considered fully relevant).
    const stmWarm: WarmResult[] = stmResults.map(entry => ({
      entry,
      score:  STM_SCALE * 1.0 + STM_OFFSET + STM_BOOST,
      source: 'stm' as const,
    }));

    // T.4: platform-lesson channel. Each hit becomes a synthetic entry with a
    // `platform:lesson:<bucketKey>` tag so the existing seed-suppression
    // filter can treat it uniformly with seed-tagged entries.
    const platformWarm: WarmResult[] = platformResults.map((hit, idx) => ({
      entry: {
        id: `platform:${hit.bucketKey}:${idx}`,
        summary: hit.summary,
        ...(hit.body !== undefined ? { body: hit.body } : {}),
        tags: [`platform:lesson:${hit.bucketKey}`],
        source: 'platform-lesson' as const,
      } satisfies PlatformLessonEntry,
      score: PLATFORM_LESSON_SCALE * hit.score + PLATFORM_LESSON_OFFSET,
      source: 'platform' as const,
    }));

    // ── Merge, filter suppressed seeds, sort, deduplicate, slice ──────────────

    const all = [...agentWarm, ...projectWarm, ...stmWarm, ...tenantWarm, ...platformWarm];

    // T.2.a: drop any entry carrying a `seed:suppressed:*` tag. Suppression is
    // applied out-of-band by the seed-feedback worker when down_count crosses
    // its threshold; this filter is the runtime enforcement. Organic entries
    // (no seed: tag) and STM entries (no tags field) are unaffected.
    // T.7: also drop `seed:retired:*` tags. Retired seeds are tombstoned by
    // the catalog reconciler — kept in the tenant collection for audit but
    // excluded from recall.
    const filtered = all.filter((r) => {
      const tags = (r.entry as { tags?: readonly string[] }).tags;
      return !isSuppressedSeedTagged(tags) && !isRetiredSeedTagged(tags);
    });

    // Sort descending by score first so that when we deduplicate we always keep
    // the highest-scored occurrence of each summary.
    filtered.sort((a, b) => b.score - a.score);

    // Deduplicate by entry.summary string equality.
    // Same semantic content can appear in multiple channels (original vs promoted
    // copy), and ids diverge between them while summaries remain identical.
    const seen    = new Set<string>();
    const deduped = filtered.filter(r => {
      const fp = r.entry.summary;
      if (seen.has(fp)) return false;
      seen.add(fp);
      return true;
    });

    return deduped.slice(0, topK);
  }
}

