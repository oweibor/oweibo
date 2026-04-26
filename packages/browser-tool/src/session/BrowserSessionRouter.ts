/**
 * BrowserSessionRouter — `auto` backend signal-aware selection (v9.5.9).
 *
 * Consulted by BrowserSessionManager.createSession() when
 * `config.backend === 'auto'`. Examines all available signals to pick the
 * optimal backend for the target URL. Prior to v9.5.9 users had to specify
 * `--backend` on every CLI invocation; with `auto` as the new default, the
 * router selects:
 *
 *   1. cloud (Bright Data / Browserbase)  ── domain reputation says cloud-required
 *   2. extension                            ── paired extension session available
 *   3. persistent (with stealth pool)       ── auth/checkout task + warmed profile
 *   4. persistent (cloud-preferred + pool)  ── Cloudflare-heavy domains
 *   5. local                                ── fallback
 *
 * Every routing decision is gated by `securityContext` flags so an admin can
 * disable any backend at the tenant level.
 */

import type { ISecurityContext } from '@oweibo/core-contracts';

import type { DomainReputationStore } from './DomainReputationStore.js';

export type BackendCandidate =
  | 'local' | 'persistent' | 'extension' | 'userchrome' | 'browserbase' | 'brightdata';

export interface RoutingContext {
  tenantId: string;
  /** Initial URL the session will navigate to; used for domain reputation lookup. */
  targetUrl: string;
  securityContext: ISecurityContext;
  /** A paired extension session is currently available for this tenant. */
  extensionConnected: boolean;
  /** A persistent profile already exists on disk for this tenant. */
  persistentProfileExists: boolean;
  /** Stealth profile pool has at least one warmed persona ready. */
  stealthPoolAvailable: boolean;
  /** Hint about the kind of work the agent is about to do. */
  taskHint?: 'research' | 'checkout' | 'auth' | 'form';
}

export interface RoutingDecision {
  backend: BackendCandidate;
  /** Whether the chosen persistent backend should pull from the stealth pool. */
  useStealthPool: boolean;
  /** Free-form audit string explaining the rule that fired. */
  reason: string;
}

interface IBrowserBridgeStatus {
  hasActiveSession(tenantId: string): boolean;
}

interface IProfileExistsCheck {
  exists(tenantId: string): Promise<boolean>;
}

interface IStealthPoolStatus {
  availableCount(): Promise<number>;
}

export interface BrowserSessionRouterDeps {
  reputationStore: DomainReputationStore;
  bridge:          IBrowserBridgeStatus;
  profileStore:    IProfileExistsCheck;
  stealthPool:     IStealthPoolStatus;
}

export class BrowserSessionRouter {
  constructor(private readonly deps: BrowserSessionRouterDeps) {}

  /**
   * Build a RoutingContext from the partial information available at
   * createSession() time. The router does not call out to network services
   * here — only fast in-memory / disk lookups.
   */
  async buildContext(input: {
    tenantId: string;
    targetUrl: string;
    securityContext: ISecurityContext;
    taskHint?: RoutingContext['taskHint'];
  }): Promise<RoutingContext> {
    const [persistentProfileExists, stealthPoolCount] = await Promise.all([
      this.deps.profileStore.exists(input.tenantId).catch(() => false),
      this.deps.stealthPool.availableCount().catch(() => 0),
    ]);
    return {
      tenantId: input.tenantId,
      targetUrl: input.targetUrl,
      securityContext: input.securityContext,
      extensionConnected: this.deps.bridge.hasActiveSession(input.tenantId),
      persistentProfileExists,
      stealthPoolAvailable: stealthPoolCount > 0,
      taskHint: input.taskHint,
    };
  }

  /** Apply routing rules to a fully built context and return the selected backend. */
  async selectBackend(ctx: RoutingContext): Promise<RoutingDecision> {
    const tier = await this.lookupTier(ctx.targetUrl);

    // Rule 1 — domain demands cloud (heavily fortified anti-bot, geo-pinned, etc.)
    if (tier === 'cloud-required') {
      const cloud = ctx.securityContext.allowBrightData ? 'brightdata' : 'browserbase';
      return { backend: cloud, useStealthPool: false, reason: `domain tier=cloud-required → ${cloud}` };
    }

    // Rule 2 — paired extension is the highest-trust signal: real cookies, real IP,
    // real browser fingerprint. Almost always the best pick when available.
    if (ctx.extensionConnected && ctx.securityContext.allowExtensionBridge) {
      return { backend: 'extension', useStealthPool: false, reason: 'extension paired + permitted' };
    }

    // Rule 3 — auth / checkout flows benefit from IndexedDB + service worker
    // persistence; require an existing profile to avoid cold-start friction.
    if ((ctx.taskHint === 'auth' || ctx.taskHint === 'checkout')
        && ctx.persistentProfileExists
        && ctx.securityContext.allowPersistentProfile) {
      return {
        backend: 'persistent',
        useStealthPool: false,
        reason: `taskHint=${ctx.taskHint} + persistent profile available`,
      };
    }

    // Rule 4 — Cloudflare-heavy or bot-sensitive: stealth-warmed persona.
    if (tier === 'cloud-preferred'
        && ctx.stealthPoolAvailable
        && ctx.securityContext.allowPersistentProfile) {
      return {
        backend: 'persistent',
        useStealthPool: true,
        reason: 'domain tier=cloud-preferred + stealth pool available',
      };
    }

    // Rule 5 — fallback.
    return { backend: 'local', useStealthPool: false, reason: 'no preferred signal; defaulting to local' };
  }

  private async lookupTier(targetUrl: string): Promise<'cloud-required' | 'cloud-preferred' | 'unknown'> {
    if (!targetUrl) return 'unknown';
    let host: string;
    try { host = new URL(targetUrl).hostname; }
    catch { return 'unknown'; }

    const store = this.deps.reputationStore as unknown as {
      getTier?: (h: string) => Promise<'cloud-required' | 'cloud-preferred' | 'unknown'>;
    };
    if (typeof store.getTier === 'function') {
      try { return await store.getTier(host); }
      catch { return 'unknown'; }
    }
    return 'unknown';
  }
}
