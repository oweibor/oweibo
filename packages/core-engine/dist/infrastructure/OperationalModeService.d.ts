import type { Pool } from 'pg';
export type PlatformMode = 0 | 1 | 2 | 3 | 4 | 5;
export type OperationType = 'cohort_routing' | 'bandit_learning' | 'gepa_evals' | 'gepa_mutations' | 'promotions';
export declare const MODE_NAMES: Record<PlatformMode, string>;
export interface ModeState {
    currentMode: PlatformMode;
    setBy: string;
    setAt: string;
    reason: string;
    autoTrigger: string | null;
}
export interface SetModeOptions {
    reason: string;
    setBy: string;
    autoTrigger?: string;
}
export declare class OperationDisabledError extends Error {
    readonly operation: OperationType;
    readonly currentMode: PlatformMode;
    readonly requiredMode: PlatformMode;
    constructor(operation: OperationType, currentMode: PlatformMode, requiredMode: PlatformMode);
}
export declare class OperationalModeService {
    private readonly pool;
    /** Optional: Redis publish callback for cache-invalidation broadcast. */
    private readonly redisPub?;
    /** Optional: Redis subscribe callback for cache-invalidation reception. */
    private readonly redisSub?;
    private cachedMode;
    private cacheExpiresAt;
    private readonly TTL_MS;
    constructor(pool: Pool, 
    /** Optional: Redis publish callback for cache-invalidation broadcast. */
    redisPub?: ((channel: string, msg: string) => Promise<void>) | undefined, 
    /** Optional: Redis subscribe callback for cache-invalidation reception. */
    redisSub?: ((channel: string, handler: (msg: string) => void) => void) | undefined);
    /**
     * Returns the current platform mode.
     * Cached for 30s; returns 5 (full operation) on any DB error — fail-open.
     */
    getMode(): Promise<PlatformMode>;
    /**
     * Returns full mode state including metadata.
     */
    getModeState(): Promise<ModeState | null>;
    /**
     * Returns true if the operation is allowed at the current mode.
     */
    isAllowed(op: OperationType): Promise<boolean>;
    /**
     * Throws OperationDisabledError if op is blocked at the current mode.
     * Call this from entry points that should abort, not silently degrade.
     */
    assertAllowed(op: OperationType): Promise<void>;
    /**
     * Transition to a new mode. Writes to DB, invalidates cache, broadcasts.
     * Throws if the transition would be a no-op (same mode).
     */
    setMode(newMode: PlatformMode, opts: SetModeOptions): Promise<void>;
    /**
     * Load the last N transitions for display in the admin UI.
     */
    getTransitionHistory(limit?: number): Promise<Array<{
        id: string;
        fromMode: PlatformMode;
        toMode: PlatformMode;
        setBy: string;
        setAt: string;
        reason: string;
        autoTrigger: string | null;
    }>>;
    /** Force-clear the in-memory cache (used in tests). */
    invalidateCache(): void;
}
//# sourceMappingURL=OperationalModeService.d.ts.map