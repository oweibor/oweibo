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
import type { ShortTermMemoryStore } from './ShortTermMemoryStore.js';
import type { UserProfileStore } from './UserProfileStore.js';
export interface NudgeConfig {
    enabled: boolean;
    nudgeInterval: number;
    nudgeWindowSize: number;
    minConfidence: number;
    maxSignalsPerRun: number;
}
export declare const NUDGE_DEFAULTS: NudgeConfig;
export declare class PreferenceNudgeService {
    private readonly stm;
    private readonly userProfileStore;
    private readonly logger;
    private readonly vaultConfig;
    constructor(stm: ShortTermMemoryStore, userProfileStore: UserProfileStore, logger: {
        warn(...a: unknown[]): void;
        info(...a: unknown[]): void;
        debug(...a: unknown[]): void;
    }, vaultConfig?: Partial<NudgeConfig>);
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
    maybeNudge(ctx: {
        tenantId: string;
        userId: string | undefined;
        sessionId: string;
        turnIndex: number;
    }): Promise<void>;
    /** Entire nudge body is wrapped so no error can escape to the caller. */
    private _runNudge;
    /**
     * detectSignals — call an LLM to extract implicit preference signals from
     * a block of turn summaries.
     *
     * // TODO: wire ModelRouter (§6b) — replace stub body with a structured
     * // LLM call that returns Array<{ key, value, confidence }>.
     */
    private detectSignals;
}
//# sourceMappingURL=PreferenceNudgeService.d.ts.map