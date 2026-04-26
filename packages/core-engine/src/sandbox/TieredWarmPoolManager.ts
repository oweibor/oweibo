/**
 * TieredWarmPoolManager — tiered warm pool for sandbox VMs (§7.3 revised).
 *
 * Manages Hot/Warm/Cold tiers of pre-booted sandbox instances.
 * Enforces healthCheck() on every release. Evicts stale instances.
 */
import type { ISandbox, ISandboxResourceLimits, ISecurityContext } from '@oweibo/core-contracts';
import type { SandboxFactory } from './SandboxFactory.js';
import type { AcquireOptions } from './WarmPoolManager.js';

type Tier = 'hot' | 'warm' | 'cold';

interface TierConfig {
  readonly maxSize: number;
  readonly maxIdleMs: number;
}

interface PoolEntry {
  readonly sandbox: ISandbox;
  readonly tier: Tier;
  readonly acquiredAt: number | null;
  readonly lastUsedAt: number;
  readonly tenantId: string | null;
}

const TIER_CONFIGS: Record<Tier, TierConfig> = {
  hot:  { maxSize: 5,  maxIdleMs: 5 * 60_000 },
  warm: { maxSize: 10, maxIdleMs: 15 * 60_000 },
  cold: { maxSize: 20, maxIdleMs: 60 * 60_000 },
};

const DEFAULT_LIMITS: ISandboxResourceLimits = {
  cpuCores: 1, memoryMB: 512, diskMB: 1024,
  timeoutMs: 60_000, networkPolicy: 'none',
};

export class TieredWarmPoolManager {
  private readonly pool: PoolEntry[] = [];
  private evictTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly factory: SandboxFactory) {}

  start(evictIntervalMs = 30_000): void {
    if (this.evictTimer) return;
    this.evictTimer = setInterval(() => this.evictStale(), evictIntervalMs);
  }

  stop(): void {
    if (this.evictTimer) {
      clearInterval(this.evictTimer);
      this.evictTimer = null;
    }
  }

  async acquire(secCtx: ISecurityContext, opts: AcquireOptions = {}): Promise<ISandbox> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const deadline = Date.now() + timeoutMs;

    // Try to find an idle sandbox, preferring hot tier
    for (const tier of ['hot', 'warm', 'cold'] as const) {
      const idx = this.pool.findIndex(
        e => e.tier === tier && e.acquiredAt === null,
      );
      if (idx !== -1) {
        const entry = this.pool[idx]!;  // safe: findIndex returned a valid index
        this.pool[idx] = { sandbox: entry.sandbox, tier: entry.tier, acquiredAt: Date.now(), lastUsedAt: entry.lastUsedAt, tenantId: secCtx.tenantId ?? null };
        return entry.sandbox;
      }
    }

    // No idle sandbox — cold-boot a new one if under max pool size
    const totalSize = this.pool.length;
    const maxTotal = TIER_CONFIGS.hot.maxSize + TIER_CONFIGS.warm.maxSize + TIER_CONFIGS.cold.maxSize;
    if (totalSize >= maxTotal) {
      // Wait for one to become available
      const waitStart = Date.now();
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
        const freeIdx = this.pool.findIndex(e => e.acquiredAt === null);
        if (freeIdx !== -1) {
          const entry = this.pool[freeIdx]!;  // safe: findIndex returned a valid index
          this.pool[freeIdx] = { sandbox: entry.sandbox, tier: entry.tier, acquiredAt: Date.now(), lastUsedAt: entry.lastUsedAt, tenantId: secCtx.tenantId ?? null };
          return entry.sandbox;
        }
      }
      throw new Error(`[WarmPool] acquire() timed out after ${Date.now() - waitStart}ms — all ${maxTotal} slots occupied`);
    }

    const sandbox = await this.factory.createSandbox();
    await sandbox.bootVM(DEFAULT_LIMITS);
    this.pool.push({
      sandbox,
      tier: this.selectTier(),
      acquiredAt: Date.now(),
      lastUsedAt: Date.now(),
      tenantId: secCtx.tenantId ?? null,
    });
    return sandbox;
  }

  async release(sandbox: ISandbox): Promise<void> {
    const idx = this.pool.findIndex(e => e.sandbox === sandbox);
    if (idx === -1) return;

    const healthy = await sandbox.healthCheck();
    if (!healthy) {
      await sandbox.destroyVM().catch(() => {});
      this.pool.splice(idx, 1);
      return;
    }

    const current = this.pool[idx]!;  // safe: idx !== -1 guard above
    this.pool[idx] = {
      sandbox: current.sandbox,
      tier:    current.tier,
      acquiredAt: null,
      lastUsedAt: Date.now(),
      tenantId:   null,
    };
  }

  private async evictStale(): Promise<void> {
    const now = Date.now();
    const toEvict: number[] = [];

    for (let i = 0; i < this.pool.length; i++) {
      const entry = this.pool[i]!;  // safe: i < this.pool.length
      if (entry.acquiredAt !== null) continue;
      const config = TIER_CONFIGS[entry.tier];
      if (now - entry.lastUsedAt > config.maxIdleMs) {
        toEvict.push(i);
      }
    }

    for (const idx of toEvict.reverse()) {
      const entry = this.pool[idx]!;  // safe: idx came from the loop above
      await entry.sandbox.destroyVM().catch(() => {});
      this.pool.splice(idx, 1);
    }
  }

  private selectTier(): Tier {
    const counts = { hot: 0, warm: 0, cold: 0 };
    for (const e of this.pool) counts[e.tier]++;

    if (counts.hot < TIER_CONFIGS.hot.maxSize) return 'hot';
    if (counts.warm < TIER_CONFIGS.warm.maxSize) return 'warm';
    return 'cold';
  }

  get stats(): { total: number; active: number; idle: number } {
    const active = this.pool.filter(e => e.acquiredAt !== null).length;
    return { total: this.pool.length, active, idle: this.pool.length - active };
  }
}
