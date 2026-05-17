import type { PromptRegistry } from '@oweibo/prompt-registry';
import type { PromptAssembler } from '@oweibo/prompt-registry';
import type { SlotPin, CanonicalRole } from '@oweibo/core-contracts';
import type { BanditService } from '../bandit/BanditService.js';
import type { OperationalModeService } from './OperationalModeService.js';
export type { CanonicalRole } from '@oweibo/core-contracts';
export interface RoleResolution {
    promptText: string;
    assembledHash: string;
    channel: string;
    slotPins: readonly SlotPin[];
}
export declare class CohortRouter {
    private readonly registry;
    private readonly assembler;
    private readonly forceChannel?;
    private readonly bandit?;
    /** Optional Redis subscribe callback for cache invalidation (≤60s lag). */
    private readonly onInvalidate?;
    /** Optional operational mode service — enforces §17.5.1 state machine. */
    private readonly operationalMode?;
    private readonly cache;
    constructor(registry: PromptRegistry, assembler: PromptAssembler, forceChannel?: string | undefined, bandit?: BanditService | undefined, 
    /** Optional Redis subscribe callback for cache invalidation (≤60s lag). */
    onInvalidate?: ((handler: (msg: string) => void) => void) | undefined, 
    /** Optional operational mode service — enforces §17.5.1 state machine. */
    operationalMode?: OperationalModeService | undefined);
    /**
     * Resolve prompt version for a single role.
     * Checks LRU cache first; falls back to stable-v0 on any error.
     */
    resolveForRole(role: CanonicalRole, taskId: string, channel?: string): Promise<RoleResolution>;
    /** Resolve all four roles atomically. Used by SwarmCoordinator.startTask(). */
    resolveAllRoles(taskId: string, channel?: string): Promise<Record<CanonicalRole, RoleResolution>>;
}
/** Last-resort static fallbacks (§2.8). */
export declare const STABLE_V0_FALLBACKS: Record<CanonicalRole, string>;
//# sourceMappingURL=CohortRouter.d.ts.map