import type { Pool } from 'pg';
export type ViolationType = 'xss' | 'pii' | 'prompt_injection' | 'platform_identifier';
export interface SafetyContext {
    channel?: string;
    promptHash?: string;
    role?: string;
    taskId?: string;
}
export interface SafetyViolation {
    type: ViolationType;
    /** Redacted match — PII masked with *; others truncated to 80 chars. */
    matched: string;
    context: SafetyContext;
}
export declare class ProductionSafetyChecker {
    /** Postgres pool for advisory-locked channel rollback (D.8). Omit to disable rollback. */
    private readonly pool?;
    private readonly sampleRate;
    /** Called synchronously after counter increment + rollback attempt, for alerting integrations. */
    private readonly onViolation?;
    constructor(
    /** Postgres pool for advisory-locked channel rollback (D.8). Omit to disable rollback. */
    pool?: Pool | undefined, sampleRate?: number, 
    /** Called synchronously after counter increment + rollback attempt, for alerting integrations. */
    onViolation?: ((v: SafetyViolation) => void) | undefined);
    /**
     * Fire-and-forget sampling gate.
     * Returns immediately; all work is async and isolated from the task path.
     * ≤200ms budget is enforced inside runCheck.
     */
    sampleAndCheck(output: string, ctx: SafetyContext): void;
    private runCheck;
    /**
     * D.8 — Revert oweibo.channels rows for the given channel (and optionally role/hash)
     * back to stable-v0. Uses pg_advisory_xact_lock keyed on the channel name to prevent
     * concurrent rollback races between auto-promotion and manual rollback (§12 threat table).
     */
    private rollbackChannel;
}
//# sourceMappingURL=ProductionSafetyChecker.d.ts.map