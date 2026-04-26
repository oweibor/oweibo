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
export type BackendCandidate = 'local' | 'persistent' | 'extension' | 'userchrome' | 'browserbase' | 'brightdata';
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
    bridge: IBrowserBridgeStatus;
    profileStore: IProfileExistsCheck;
    stealthPool: IStealthPoolStatus;
}
export declare class BrowserSessionRouter {
    private readonly deps;
    constructor(deps: BrowserSessionRouterDeps);
    /**
     * Build a RoutingContext from the partial information available at
     * createSession() time. The router does not call out to network services
     * here — only fast in-memory / disk lookups.
     */
    buildContext(input: {
        tenantId: string;
        targetUrl: string;
        securityContext: ISecurityContext;
        taskHint?: RoutingContext['taskHint'];
    }): Promise<RoutingContext>;
    /** Apply routing rules to a fully built context and return the selected backend. */
    selectBackend(ctx: RoutingContext): Promise<RoutingDecision>;
    private lookupTier;
}
export {};
//# sourceMappingURL=BrowserSessionRouter.d.ts.map