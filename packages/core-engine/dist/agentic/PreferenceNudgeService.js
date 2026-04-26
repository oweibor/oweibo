"use strict";
/**
 * PreferenceNudgeService — session-end preference detection from STM turns.
 *
 * On every nudgeInterval-th turn, scans the last nudgeWindowSize STM entries
 * for implicit preference signals (e.g. "user asked for bullet points twice").
 * Qualified signals (confidence >= minConfidence) are written to UserProfileStore
 * via upsertPreference() — never to LongTermMemoryStore.
 *
 * The LLM call is stubbed (detectSignals returns [] until ModelRouter is wired
 * in §6b). The guard chain and write path are fully operative.
 *
 * Design constraints:
 *   - Never throws — all errors are caught and logged at warn level.
 *   - Never logs preference values — they may contain PII.
 *   - No dependency on LongTermMemoryStore (hard architectural constraint).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PreferenceNudgeService = exports.NUDGE_DEFAULTS = void 0;
exports.NUDGE_DEFAULTS = {
    enabled: true,
    nudgeInterval: 5,
    nudgeWindowSize: 10,
    minConfidence: 0.75,
    maxSignalsPerRun: 3,
};
// ─── Service ──────────────────────────────────────────────────────────────────
class PreferenceNudgeService {
    stm;
    userProfileStore;
    logger;
    vaultConfig;
    constructor(stm, userProfileStore, logger, vaultConfig = {}) {
        this.stm = stm;
        this.userProfileStore = userProfileStore;
        this.logger = logger;
        this.vaultConfig = vaultConfig;
    }
    // ── Public API ─────────────────────────────────────────────────────────────
    /**
     * maybeNudge — evaluate whether this turn should trigger a preference scan.
     *
     * Guard chain (short-circuits in declaration order):
     *   1. cfg.enabled        — master switch
     *   2. ctx.userId         — anonymous sessions have no profile to write to
     *   3. ctx.turnIndex === 0 — first turn, nothing to review yet
     *   4. ctx.turnIndex % cfg.nudgeInterval !== 0 — not a nudge turn
     *
     * Never throws. All failures inside _runNudge are caught and logged.
     */
    async maybeNudge(ctx) {
        const cfg = { ...exports.NUDGE_DEFAULTS, ...this.vaultConfig };
        // ── Guard chain ───────────────────────────────────────────────────────────
        if (!cfg.enabled)
            return;
        if (!ctx.userId)
            return;
        if (ctx.turnIndex === 0)
            return;
        if (ctx.turnIndex % cfg.nudgeInterval !== 0)
            return;
        // Confirmed nudge turn — delegate to the guarded runner.
        await this._runNudge(cfg, ctx);
    }
    // ── Private implementation ─────────────────────────────────────────────────
    /** Entire nudge body is wrapped so no error can escape to the caller. */
    async _runNudge(cfg, ctx) {
        try {
            const { tenantId, userId, sessionId } = ctx;
            // 1. Fetch recent STM entries from the hot layer.
            const recent = this.stm.recallRecent({
                tenantId,
                sessionId,
                limit: cfg.nudgeWindowSize,
            });
            // Need at least 2 turns to detect a pattern.
            if (recent.length < 2)
                return;
            // 2. Detect preference signals from the concatenated summaries.
            const summaries = recent.map(r => r.summary).join('\n');
            let rawSignals;
            try {
                rawSignals = await this.detectSignals(summaries);
            }
            catch (err) {
                this.logger.warn('[PreferenceNudgeService] detectSignals failed — skipping nudge', { sessionId, turnIndex: ctx.turnIndex, error: err.message });
                return;
            }
            // 3. Filter: shape guard + confidence threshold.
            const qualified = rawSignals
                .filter((s) => typeof s.key === 'string' &&
                typeof s.value === 'string' &&
                typeof s.confidence === 'number' &&
                s.confidence >= cfg.minConfidence)
                .slice(0, cfg.maxSignalsPerRun);
            if (qualified.length === 0)
                return;
            // 4. Persist — values intentionally excluded from log (PII risk).
            await Promise.all(qualified.map(s => this.userProfileStore.upsertPreference(tenantId, userId, s.key, s.value, s.confidence)));
            this.logger.info('[PreferenceNudgeService] wrote preference signals', {
                count: qualified.length,
                keys: qualified.map(s => s.key),
                userId,
                sessionId,
            });
        }
        catch (err) {
            this.logger.warn('[PreferenceNudgeService] nudge run failed — continuing without preference update', { sessionId: ctx.sessionId, error: err.message });
        }
    }
    // ── Stub — will be replaced when ModelRouter is wired ────────────────────
    /**
     * detectSignals — call an LLM to extract implicit preference signals from
     * a block of turn summaries.
     *
     * // TODO: wire ModelRouter (§6b) — replace stub body with a structured
     * // LLM call that returns Array<{ key, value, confidence }>.
     */
    async detectSignals(_summaries) {
        // TODO: wire ModelRouter (§6b)
        return [];
    }
}
exports.PreferenceNudgeService = PreferenceNudgeService;
//# sourceMappingURL=PreferenceNudgeService.js.map