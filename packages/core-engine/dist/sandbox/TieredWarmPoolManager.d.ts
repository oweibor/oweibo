/**
 * TieredWarmPoolManager — tiered warm pool for sandbox VMs (§7.3 revised).
 *
 * Manages Hot/Warm/Cold tiers of pre-booted sandbox instances.
 * Enforces healthCheck() on every release. Evicts stale instances.
 */
import type { ISandbox, ISecurityContext } from '@oweibo/core-contracts';
import type { SandboxFactory } from './SandboxFactory.js';
import type { AcquireOptions } from './WarmPoolManager.js';
export declare class TieredWarmPoolManager {
    private readonly factory;
    private readonly pool;
    private evictTimer;
    constructor(factory: SandboxFactory);
    start(evictIntervalMs?: number): void;
    stop(): void;
    acquire(secCtx: ISecurityContext, opts?: AcquireOptions): Promise<ISandbox>;
    release(sandbox: ISandbox): Promise<void>;
    private evictStale;
    private selectTier;
    get stats(): {
        total: number;
        active: number;
        idle: number;
    };
}
//# sourceMappingURL=TieredWarmPoolManager.d.ts.map