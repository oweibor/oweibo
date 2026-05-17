// §17.5.1 — Platform operational mode state machine.
// Enforces a six-mode hierarchy backed by oweibo.platform_operational_mode.
// Every relevant entry point (CohortRouter, BanditService, GEPA) reads mode
// before operating and aborts if its operation is disabled.
//
// Fail-open: on DB errors, assumes mode 5 (full operation) to avoid
// blocking tasks. This is the safe default — if mode cannot be read,
// we assume we're allowed to proceed. Explicit degradation is human-initiated.
//
// Cache: in-memory 30s TTL + optional Redis publish/subscribe for invalidation.

import type { Pool } from 'pg';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PlatformMode = 0 | 1 | 2 | 3 | 4 | 5;

export type OperationType =
  | 'cohort_routing'    // blocked at mode 0 — CohortRouter returns stable-v0 directly
  | 'bandit_learning'   // blocked at mode ≤ 3 — reward updates pause
  | 'gepa_evals'        // blocked at mode ≤ 3 — eval runs disabled below mode 4
  | 'gepa_mutations'    // blocked at mode ≤ 4 — mutations only at full operation (5)
  | 'promotions';       // blocked at mode ≤ 1 — channel pointers frozen

/** Minimum mode at which an operation is permitted. */
const MIN_MODE_FOR: Record<OperationType, PlatformMode> = {
  cohort_routing:  1,   // mode 0 = stable-v0 only
  bandit_learning: 4,   // modes 0-3 = reward updates paused
  gepa_evals:      4,   // modes 0-3 = GEPA fully disabled
  gepa_mutations:  5,   // modes 0-4 = no mutation generation
  promotions:      2,   // modes 0-1 = channel pointers frozen
};

export const MODE_NAMES: Record<PlatformMode, string> = {
  5: 'Full operation',
  4: 'Eval-only',
  3: 'No bandit learning',
  2: 'No GEPA mutations',
  1: 'No promotions',
  0: 'Full freeze (stable-v0 only)',
};

export interface ModeState {
  currentMode: PlatformMode;
  setBy:       string;
  setAt:       string;
  reason:      string;
  autoTrigger: string | null;
}

export interface SetModeOptions {
  reason:       string;
  setBy:        string;
  autoTrigger?: string;  // populated for Prometheus-rule-driven transitions
}

export class OperationDisabledError extends Error {
  constructor(
    public readonly operation:    OperationType,
    public readonly currentMode:  PlatformMode,
    public readonly requiredMode: PlatformMode,
  ) {
    super(
      `Operation '${operation}' is disabled at platform mode ${currentMode} (${MODE_NAMES[currentMode]}). ` +
      `Requires mode ≥ ${requiredMode}.`,
    );
    this.name = 'OperationDisabledError';
  }
}

// ── OperationalModeService ────────────────────────────────────────────────────

export class OperationalModeService {
  private cachedMode:      PlatformMode | null = null;
  private cacheExpiresAt   = 0;
  private readonly TTL_MS  = 30_000;   // 30-second cache per §17.5.1

  constructor(
    private readonly pool:       Pool,
    /** Optional: Redis publish callback for cache-invalidation broadcast. */
    private readonly redisPub?:  (channel: string, msg: string) => Promise<void>,
    /** Optional: Redis subscribe callback for cache-invalidation reception. */
    private readonly redisSub?:  (channel: string, handler: (msg: string) => void) => void,
  ) {
    // Subscribe to invalidation broadcasts from other pods
    this.redisSub?.(INVALIDATION_CHANNEL, () => {
      this.cachedMode    = null;
      this.cacheExpiresAt = 0;
    });
  }

  /**
   * Returns the current platform mode.
   * Cached for 30s; returns 5 (full operation) on any DB error — fail-open.
   */
  async getMode(): Promise<PlatformMode> {
    if (this.cachedMode !== null && Date.now() < this.cacheExpiresAt) {
      return this.cachedMode;
    }

    try {
      const result = await this.pool.query<{ current_mode: number }>(
        `SELECT current_mode FROM oweibo.platform_operational_mode WHERE singleton_id = TRUE`,
      );
      const raw = result.rows[0]?.current_mode ?? 5;
      const mode = Math.max(0, Math.min(5, raw)) as PlatformMode;

      this.cachedMode    = mode;
      this.cacheExpiresAt = Date.now() + this.TTL_MS;
      return mode;
    } catch {
      // Fail-open: if we cannot read the mode, assume full operation
      return 5;
    }
  }

  /**
   * Returns full mode state including metadata.
   */
  async getModeState(): Promise<ModeState | null> {
    try {
      const result = await this.pool.query<{
        current_mode: number;
        set_by:       string;
        set_at:       string;
        reason:       string;
        auto_trigger: string | null;
      }>(`SELECT current_mode, set_by, set_at, reason, auto_trigger
          FROM oweibo.platform_operational_mode WHERE singleton_id = TRUE`);

      const row = result.rows[0];
      if (!row) return null;

      return {
        currentMode: Math.max(0, Math.min(5, row.current_mode)) as PlatformMode,
        setBy:       row.set_by,
        setAt:       row.set_at,
        reason:      row.reason,
        autoTrigger: row.auto_trigger,
      };
    } catch {
      return null;
    }
  }

  /**
   * Returns true if the operation is allowed at the current mode.
   */
  async isAllowed(op: OperationType): Promise<boolean> {
    const mode = await this.getMode();
    return mode >= (MIN_MODE_FOR[op] as PlatformMode);
  }

  /**
   * Throws OperationDisabledError if op is blocked at the current mode.
   * Call this from entry points that should abort, not silently degrade.
   */
  async assertAllowed(op: OperationType): Promise<void> {
    const mode     = await this.getMode();
    const required = MIN_MODE_FOR[op] as PlatformMode;
    if (mode < required) {
      throw new OperationDisabledError(op, mode, required);
    }
  }

  /**
   * Transition to a new mode. Writes to DB, invalidates cache, broadcasts.
   * Throws if the transition would be a no-op (same mode).
   */
  async setMode(newMode: PlatformMode, opts: SetModeOptions): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Read current mode inside the transaction
      const current = await client.query<{ current_mode: number }>(
        `SELECT current_mode FROM oweibo.platform_operational_mode WHERE singleton_id = TRUE FOR UPDATE`,
      );
      const fromMode = (current.rows[0]?.current_mode ?? 5) as PlatformMode;

      if (fromMode === newMode) {
        await client.query('ROLLBACK');
        return; // no-op
      }

      // Update singleton row
      await client.query(
        `UPDATE oweibo.platform_operational_mode
         SET current_mode = $1, set_by = $2, set_at = NOW(), reason = $3, auto_trigger = $4
         WHERE singleton_id = TRUE`,
        [newMode, opts.setBy, opts.reason, opts.autoTrigger ?? null],
      );

      // Write audit log
      await client.query(
        `INSERT INTO oweibo.operational_mode_transitions
           (from_mode, to_mode, set_by, reason, auto_trigger)
         VALUES ($1, $2, $3, $4, $5)`,
        [fromMode, newMode, opts.setBy, opts.reason, opts.autoTrigger ?? null],
      );

      await client.query('COMMIT');

      // Invalidate local cache
      this.cachedMode    = newMode;
      this.cacheExpiresAt = Date.now() + this.TTL_MS;

      // Broadcast invalidation to other pods
      await this.redisPub?.(INVALIDATION_CHANNEL, JSON.stringify({ newMode, setAt: Date.now() }));

      console.log(
        `[OperationalModeService] Mode transition: ${fromMode} (${MODE_NAMES[fromMode]}) ` +
        `→ ${newMode} (${MODE_NAMES[newMode]}) by=${opts.setBy} reason="${opts.reason}"`,
      );
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Load the last N transitions for display in the admin UI.
   */
  async getTransitionHistory(limit = 50): Promise<Array<{
    id:          string;
    fromMode:    PlatformMode;
    toMode:      PlatformMode;
    setBy:       string;
    setAt:       string;
    reason:      string;
    autoTrigger: string | null;
  }>> {
    try {
      const result = await this.pool.query<{
        id:           string;
        from_mode:    number;
        to_mode:      number;
        set_by:       string;
        set_at:       string;
        reason:       string;
        auto_trigger: string | null;
      }>(
        `SELECT id, from_mode, to_mode, set_by, set_at, reason, auto_trigger
         FROM oweibo.operational_mode_transitions
         ORDER BY set_at DESC LIMIT $1`,
        [limit],
      );
      return result.rows.map(r => ({
        id:          r.id,
        fromMode:    Math.max(0, Math.min(5, r.from_mode)) as PlatformMode,
        toMode:      Math.max(0, Math.min(5, r.to_mode)) as PlatformMode,
        setBy:       r.set_by,
        setAt:       r.set_at,
        reason:      r.reason,
        autoTrigger: r.auto_trigger,
      }));
    } catch {
      return [];
    }
  }

  /** Force-clear the in-memory cache (used in tests). */
  invalidateCache(): void {
    this.cachedMode    = null;
    this.cacheExpiresAt = 0;
  }
}

const INVALIDATION_CHANNEL = 'platform:mode:invalidate';
