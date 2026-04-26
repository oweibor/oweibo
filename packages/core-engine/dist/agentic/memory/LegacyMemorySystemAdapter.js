"use strict";
/**
 * LegacyMemorySystemAdapter — implements the deprecated `IMemorySystem`
 * (UnifiedMemorySystem's contract) over the new `IMemoryOrchestrator`.
 *
 * # Why this adapter exists
 *
 * Two memory facades coexisted in the codebase:
 *   • Legacy: `IMemorySystem` (in `agentic/IMemorySystem.ts`) implemented by
 *     `UnifiedMemorySystem` over `LongTermMemoryStore + ShortTermMemoryStore +
 *     MemoryWarmer + STMCompressor`.
 *   • New: `IMemoryOrchestrator` (in `@oweibo/core-contracts`) implemented by
 *     `MemoryOrchestrator` over the four-tier contract (`IWorkingMemory`,
 *     `IShortTermMemoryStore`, `IProjectRegistry`, `ISemanticMemoryStore`).
 *
 * The legacy interface had a single live consumer (`ConversationalLoop`) but
 * nothing bridged the two systems — so existing code couldn't migrate without
 * a rewrite, and new code couldn't call into the legacy storage.
 *
 * This adapter is the migration path: existing `IMemorySystem` callers get an
 * implementation backed by the new orchestrator (which itself can be wired
 * over the legacy LTM via `SemanticMemoryAdapter`, so writes still land in
 * the same Qdrant collections). Storage stays unified; only the seam moves.
 *
 * # Lifetime
 *
 * Transitional. Once every `IMemorySystem` caller has been switched to depend
 * on `IMemoryOrchestrator` directly, this file, `IMemorySystem.ts`, and
 * `UnifiedMemorySystem` can all be deleted in one PR.
 *
 * # Shape translation
 *
 * Old → New:
 *   • {tenantId, projectId, sessionId}     → MemoryScope object
 *   • type   ('successful-strategy', …)    → kind  ('success-pattern', …)
 *   • tier   ('episodic'|…)                → dropped (kind subsumes tier semantics)
 *   • relevanceTags: string[]              → stashed in detail.tags so they
 *                                            survive the LTM write via
 *                                            SemanticMemoryAdapter
 *   • importance (not in legacy)           → defaulted to 0.5
 *   • userId                               → dropped (no contract equivalent)
 *
 * New → Old (for recall):
 *   • kind                                 → (type, tier) via the inverse map
 *   • importance                           → confidence
 *   • recallCount                          → successCount; missCount = 0
 *   • createdAt/updatedAt (ISO)            → Unix-ms timestamps
 *   • scope object                         → string ('session:…'/'project:…'/…)
 *
 * # Methods that don't translate cleanly
 *
 *   • warmForTask    — the new orchestrator has no warmer concept; we map it
 *                      to assembleContext + a transformation. Callers that
 *                      depended on warmer-specific scoring (success-rate,
 *                      half-life weights) get a degraded shape — see warmForTask
 *                      docstring.
 *   • reinforceMemory / penaliseMemory — the new contract has no explicit
 *                      reinforce/penalise; SemanticMemoryStore reinforces
 *                      implicitly on `recall({reinforce: true})`. The adapter
 *                      logs at warn level and resolves; behaviour is non-fatal
 *                      to match the legacy expectation that these never throw.
 *   • endSession     — legacy did STM-compression + LTM-write + STM-teardown.
 *                      The new orchestrator's STM has its own TTL-based cleanup,
 *                      so this is a teardown-only no-op by default. Callers that
 *                      hold legacy STM Redis keys outside the orchestrator can
 *                      pass an `endSessionHook` to handle their teardown.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LegacyMemorySystemAdapter = void 0;
// ── Constants ───────────────────────────────────────────────────────────────
const DEFAULT_IMPORTANCE = 0.5;
const DEFAULT_TOP_K = 5;
/** Score floor for warmForTask results — preserves the legacy 0.90 STM_SCORE. */
const WARM_RESULT_SCORE_FLOOR = 0.90;
/** Legacy MemoryType → contract MemoryKind. Maps from the 4-type legacy enum. */
const LEGACY_TYPE_TO_KIND = {
    'successful-strategy': 'success-pattern',
    'failure-pattern': 'failure-lesson',
    'tool-heuristic': 'tool-heuristic',
    'domain-knowledge': 'domain-fact',
};
/**
 * Reverse map for recall — the new contract returns MemoryKind, the legacy
 * caller expects MemoryType + MemoryTier. Tier is best-effort: a kind doesn't
 * encode a tier directly, so we pick a default that matches legacy intent
 * (procedural for reusable knowledge, episodic for one-offs).
 */
const KIND_TO_LEGACY = {
    'user-preference': { type: 'domain-knowledge', tier: 'semantic' },
    'architectural-decision': { type: 'domain-knowledge', tier: 'semantic' },
    'decision-rationale': { type: 'domain-knowledge', tier: 'semantic' },
    'failure-lesson': { type: 'failure-pattern', tier: 'episodic' },
    'success-pattern': { type: 'successful-strategy', tier: 'procedural' },
    'code-landmark': { type: 'domain-knowledge', tier: 'semantic' },
    'domain-fact': { type: 'domain-knowledge', tier: 'semantic' },
    'conversation-summary': { type: 'domain-knowledge', tier: 'episodic' },
    'project-invariant': { type: 'domain-knowledge', tier: 'procedural' },
    'open-question': { type: 'domain-knowledge', tier: 'episodic' },
    'tool-heuristic': { type: 'tool-heuristic', tier: 'procedural' },
};
const NOOP_LOGGER = {
    warn: () => { },
    debug: () => { },
};
// ── Adapter ─────────────────────────────────────────────────────────────────
/**
 * Implements `IMemorySystem` over `IMemoryOrchestrator`.
 * See module-level JSDoc for the full migration story.
 */
class LegacyMemorySystemAdapter {
    orchestrator;
    endSessionHook;
    logger;
    constructor(deps) {
        this.orchestrator = deps.orchestrator;
        this.endSessionHook = deps.endSessionHook;
        this.logger = deps.logger ?? NOOP_LOGGER;
    }
    // ── store ─────────────────────────────────────────────────────────────────
    /**
     * Translate the legacy store-input shape to the contract's StoreMemoryInput
     * and route through `orchestrator.record()`. Returns the new entry's id so
     * callers that retained handles (e.g. for later reinforce calls) keep
     * working — though the new orchestrator does not expose explicit reinforce.
     */
    async store(entry) {
        const scope = {
            tenantId: entry.tenantId,
            projectId: entry.projectId ?? undefined,
            sessionId: entry.sessionId,
        };
        // relevanceTags don't have a contract field; smuggle them through detail.tags
        // so SemanticMemoryAdapter.store can lift them back into LTM relevanceTags.
        const baseDetail = entry.detail && typeof entry.detail === 'object' && !Array.isArray(entry.detail)
            ? entry.detail
            : {};
        const detail = entry.relevanceTags && entry.relevanceTags.length > 0
            ? { ...baseDetail, tags: [...entry.relevanceTags] }
            : baseDetail;
        const recorded = await this.orchestrator.record({
            scope,
            kind: LEGACY_TYPE_TO_KIND[entry.type],
            summary: entry.summary,
            detail,
            importance: DEFAULT_IMPORTANCE,
        });
        return recorded.id;
    }
    // ── recall ────────────────────────────────────────────────────────────────
    /**
     * Translate the legacy recall query shape to `assembleContext`, then convert
     * each `RankedMemoryEntry` back to a legacy `RecallResult`. `minScore` is
     * applied as a post-filter — the contract's recall takes no minScore.
     */
    async recall(params) {
        const { tenantId, sessionId, query, topK = DEFAULT_TOP_K, minScore = 0, types } = params;
        // Map the legacy 'types' filter (4-value enum) to contract kinds. We do
        // NOT map 'tiers' — kind subsumes tier on the new path, and a tier-only
        // query has no clean translation.
        const kinds = types?.length
            ? types.map((t) => LEGACY_TYPE_TO_KIND[t])
            : undefined;
        const ctx = await this.orchestrator.assembleContext({
            scope: { tenantId, sessionId },
            query,
            kinds,
            topK,
        });
        const ranked = ctx.rankedMemories
            .filter((rm) => rm.score >= minScore)
            .slice(0, topK);
        return ranked.map((rm) => this.rankedToLegacyRecallResult(rm));
    }
    // ── warmForTask ───────────────────────────────────────────────────────────
    /**
     * The new orchestrator has no `warmForTask` equivalent — warming was a
     * legacy concept tied to the old MemoryWarmer's heuristic blends. We
     * translate to `assembleContext` and shape the output to match `WarmResult`.
     *
     * Callers that depended on warmer-specific signals (success-rate, half-life
     * weighting) should switch to `assembleContext` directly via the orchestrator
     * for proper score-breakdown access.
     */
    async warmForTask(params) {
        // The MemoryWarmer.warmForTask param shape (taken via Parameters<...>)
        // includes tenantId, sessionId, query, taskGoal, topK, etc. Field names
        // and presence vary across legacy versions — read defensively.
        const p = params;
        const ctx = await this.orchestrator.assembleContext({
            scope: { tenantId: p.tenantId, sessionId: p.sessionId },
            query: p.query ?? p.taskGoal ?? '',
            topK: p.topK ?? DEFAULT_TOP_K,
        });
        // WarmResult is { entry, score, source: 'ltm' | 'stm' }. We funnel
        // everything through 'ltm' since the contract gives us no per-result
        // channel attribution. Score is floored at 0.90 to preserve the legacy
        // STM_SCORE convention used by callers that sort warm vs ambient results.
        return ctx.rankedMemories.map((rm) => ({
            entry: this.rankedToLegacyEntry(rm),
            score: Math.max(rm.score, WARM_RESULT_SCORE_FLOOR),
            source: 'ltm',
        }));
    }
    // ── endSession ────────────────────────────────────────────────────────────
    /**
     * The legacy implementation did STM compression + LTM crash-recovery write
     * + STM destruction. The new orchestrator's STM has TTL-based cleanup, so
     * the default behaviour is a no-op + optional caller-supplied teardown for
     * legacy Redis keys held outside the orchestrator.
     *
     * Always non-throwing — matches the legacy contract that endSession failure
     * never surfaces to callers.
     */
    async endSession(tenantId, sessionId) {
        if (this.endSessionHook) {
            try {
                await this.endSessionHook(tenantId, sessionId);
            }
            catch (err) {
                this.logger.warn('[LegacyMemorySystemAdapter] endSessionHook failed (non-fatal)', {
                    tenantId, sessionId, error: err.message,
                });
            }
        }
        else {
            this.logger.debug?.('[LegacyMemorySystemAdapter] endSession: no hook supplied; orchestrator STM TTL handles cleanup', { tenantId, sessionId });
        }
    }
    // ── reinforceMemory / penaliseMemory ──────────────────────────────────────
    /**
     * No-op + warn. The new orchestrator has no explicit reinforce/penalise:
     * `ISemanticMemoryStore.recall({reinforce: true})` bumps recallCount
     * implicitly. Callers that need explicit reinforcement should switch to
     * `IMemoryOrchestrator` (and back the orchestrator with a semantic store
     * that supports it) directly.
     *
     * Resolves successfully so legacy fire-and-forget patterns don't crash.
     */
    async reinforceMemory(memoryId, tenantId) {
        this.logger.warn('[LegacyMemorySystemAdapter] reinforceMemory has no equivalent on IMemoryOrchestrator; this call is a no-op', { memoryId, tenantId });
    }
    async penaliseMemory(memoryId, tenantId) {
        this.logger.warn('[LegacyMemorySystemAdapter] penaliseMemory has no equivalent on IMemoryOrchestrator; this call is a no-op', { memoryId, tenantId });
    }
    // ── helpers ───────────────────────────────────────────────────────────────
    rankedToLegacyRecallResult(rm) {
        return {
            entry: this.rankedToLegacyEntry(rm),
            score: rm.score,
        };
    }
    /**
     * Build a legacy MemoryEntry from a contract RankedMemoryEntry. Fields the
     * contract doesn't carry (missCount, lastAccessedAt, lastReinforcedAt) are
     * synthesised from the contract's coarser timestamps. relevanceTags is
     * recovered from `detail.tags` if the original write used the smuggle path.
     */
    rankedToLegacyEntry(rm) {
        const mapping = KIND_TO_LEGACY[rm.kind];
        const createdMs = parseIsoToMs(rm.createdAt);
        const updatedMs = parseIsoToMs(rm.updatedAt);
        const tagsFromDetail = readStringArray(rm.detail, 'tags');
        return {
            id: rm.id,
            tenantId: rm.scope.tenantId,
            // userId is not in the contract scope; legacy field stays undefined.
            userId: undefined,
            projectId: rm.scope.projectId,
            scope: legacyScopeOf(rm.scope),
            type: mapping.type,
            tier: mapping.tier,
            summary: rm.summary,
            detail: rm.detail ?? rm.body ?? null,
            relevanceTags: tagsFromDetail ?? [],
            successCount: rm.recallCount,
            missCount: 0,
            // confidence in the legacy shape is "0..1 importance" — the new
            // contract's `importance` is the closest semantic match.
            confidence: rm.importance,
            createdAt: createdMs,
            lastAccessedAt: updatedMs,
            lastReinforcedAt: updatedMs,
        };
    }
}
exports.LegacyMemorySystemAdapter = LegacyMemorySystemAdapter;
// ── module-private utilities ────────────────────────────────────────────────
/**
 * Build the legacy single-string scope from the contract's structured scope.
 * Mirrors `SemanticMemoryAdapter.ltmScopeOf` so writes and reads see the same
 * convention regardless of which adapter sits in front of the LTM.
 */
function legacyScopeOf(scope) {
    if (scope.projectId)
        return `project:${scope.projectId}`;
    if (scope.taskId)
        return `task:${scope.taskId}`;
    if (scope.sessionId)
        return `session:${scope.sessionId}`;
    return `tenant:${scope.tenantId}`;
}
function parseIsoToMs(iso) {
    const ms = Date.parse(iso);
    // Date.parse returns NaN on garbage; fall back to "now" so callers that
    // compute decay scores from these timestamps don't hit NaN arithmetic.
    return Number.isFinite(ms) ? ms : Date.now();
}
function readStringArray(detail, key) {
    const v = detail?.[key];
    if (!Array.isArray(v))
        return undefined;
    return v.filter((x) => typeof x === 'string');
}
//# sourceMappingURL=LegacyMemorySystemAdapter.js.map