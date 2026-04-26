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

// ─── Config ───────────────────────────────────────────────────────────────────

export interface NudgeConfig {
  enabled:           boolean;  // master on/off switch
  nudgeInterval:     number;   // fire on every Nth turn (default: 5)
  nudgeWindowSize:   number;   // how many recent STM entries to review (default: 10)
  minConfidence:     number;   // minimum signal confidence to write (default: 0.75)
  maxSignalsPerRun:  number;   // cap on upsertPreference() calls per nudge (default: 3)
}

export const NUDGE_DEFAULTS: NudgeConfig = {
  enabled:          true,
  nudgeInterval:    5,
  nudgeWindowSize:  10,
  minConfidence:    0.75,
  maxSignalsPerRun: 3,
};

// ─── Internal signal shape ────────────────────────────────────────────────────

interface PreferenceSignal {
  key:        string;
  value:      string;
  confidence: number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class PreferenceNudgeService {
  constructor(
    private readonly stm:              ShortTermMemoryStore,
    private readonly userProfileStore: UserProfileStore,
    private readonly logger: {
      warn(...a:  unknown[]): void;
      info(...a:  unknown[]): void;
      debug(...a: unknown[]): void;
    },
    private readonly vaultConfig: Partial<NudgeConfig> = {},
  ) {}

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
  async maybeNudge(ctx: {
    tenantId:   string;
    userId:     string | undefined;
    sessionId:  string;
    turnIndex:  number;
  }): Promise<void> {
    const cfg: NudgeConfig = { ...NUDGE_DEFAULTS, ...this.vaultConfig };

    // ── Guard chain ───────────────────────────────────────────────────────────
    if (!cfg.enabled)                             return;
    if (!ctx.userId)                              return;
    if (ctx.turnIndex === 0)                      return;
    if (ctx.turnIndex % cfg.nudgeInterval !== 0)  return;

    // Confirmed nudge turn — delegate to the guarded runner.
    await this._runNudge(cfg, ctx as typeof ctx & { userId: string });
  }

  // ── Private implementation ─────────────────────────────────────────────────

  /** Entire nudge body is wrapped so no error can escape to the caller. */
  private async _runNudge(
    cfg: NudgeConfig,
    ctx: { tenantId: string; userId: string; sessionId: string; turnIndex: number },
  ): Promise<void> {
    try {
      const { tenantId, userId, sessionId } = ctx;

      // 1. Fetch recent STM entries from the hot layer.
      const recent = this.stm.recallRecent({
        tenantId,
        sessionId,
        limit: cfg.nudgeWindowSize,
      });

      // Need at least 2 turns to detect a pattern.
      if (recent.length < 2) return;

      // 2. Detect preference signals from the concatenated summaries.
      const summaries = recent.map(r => r.summary).join('\n');
      let rawSignals: Array<{ key: string; value: string; confidence: number }>;
      try {
        rawSignals = await this.detectSignals(summaries);
      } catch (err) {
        this.logger.warn(
          '[PreferenceNudgeService] detectSignals failed — skipping nudge',
          { sessionId, turnIndex: ctx.turnIndex, error: (err as Error).message },
        );
        return;
      }

      // 3. Filter: shape guard + confidence threshold.
      const qualified: PreferenceSignal[] = rawSignals
        .filter((s): s is PreferenceSignal =>
          typeof s.key        === 'string' &&
          typeof s.value      === 'string' &&
          typeof s.confidence === 'number' &&
          s.confidence >= cfg.minConfidence,
        )
        .slice(0, cfg.maxSignalsPerRun);

      if (qualified.length === 0) return;

      // 4. Persist — values intentionally excluded from log (PII risk).
      await Promise.all(
        qualified.map(s =>
          this.userProfileStore.upsertPreference(
            tenantId, userId, s.key, s.value, s.confidence,
          ),
        ),
      );

      this.logger.info(
        '[PreferenceNudgeService] wrote preference signals',
        {
          count:  qualified.length,
          keys:   qualified.map(s => s.key),
          userId,
          sessionId,
        },
      );
    } catch (err) {
      this.logger.warn(
        '[PreferenceNudgeService] nudge run failed — continuing without preference update',
        { sessionId: ctx.sessionId, error: (err as Error).message },
      );
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
  private async detectSignals(
    _summaries: string,
  ): Promise<Array<{ key: string; value: string; confidence: number }>> {
    // TODO: wire ModelRouter (§6b)
    return [];
  }
}
