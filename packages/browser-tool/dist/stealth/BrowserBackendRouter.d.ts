import type { BrowserSessionConfig } from '@oweibo/core-contracts';
import type { IBrowserBackend, BrowserBackendType } from '../contracts/IBrowserBackend.js';
import type { BrowserSessionRouter, RoutingContext } from '../session/BrowserSessionRouter.js';
export declare class BrowserBackendRouter {
    private readonly backends;
    /** Optional — injected when the router should resolve 'auto' internally. */
    private readonly sessionRouter?;
    constructor(backends: Map<BrowserBackendType, IBrowserBackend>, 
    /** Optional — injected when the router should resolve 'auto' internally. */
    sessionRouter?: BrowserSessionRouter | undefined);
    /**
     * Async resolution — handles `backend === 'auto'` by consulting
     * BrowserSessionRouter when one is wired in, then falling through to
     * the existing backend map. Use this from new code paths.
     */
    resolveAsync(config: BrowserSessionConfig, routingCtx?: RoutingContext): Promise<IBrowserBackend>;
    /**
     * Synchronous resolution. `'auto'` must have been resolved to a concrete
     * backend by BrowserSessionManager before reaching here; if not, falls
     * back to 'local' with a warning (defensive).
     */
    resolve(config: BrowserSessionConfig): IBrowserBackend;
    register(backend: IBrowserBackend): void;
}
//# sourceMappingURL=BrowserBackendRouter.d.ts.map