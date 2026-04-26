"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserBackendRouter = void 0;
class BrowserBackendRouter {
    backends;
    sessionRouter;
    constructor(backends, 
    /** Optional — injected when the router should resolve 'auto' internally. */
    sessionRouter) {
        this.backends = backends;
        this.sessionRouter = sessionRouter;
    }
    /**
     * Async resolution — handles `backend === 'auto'` by consulting
     * BrowserSessionRouter when one is wired in, then falling through to
     * the existing backend map. Use this from new code paths.
     */
    async resolveAsync(config, routingCtx) {
        if (config.backend === 'auto' && this.sessionRouter && routingCtx) {
            const decision = await this.sessionRouter.selectBackend(routingCtx);
            const b = this.backends.get(decision.backend);
            if (b)
                return b;
            // Router returned a backend that isn't registered; fall through to local.
        }
        return this.resolve(config);
    }
    /**
     * Synchronous resolution. `'auto'` must have been resolved to a concrete
     * backend by BrowserSessionManager before reaching here; if not, falls
     * back to 'local' with a warning (defensive).
     */
    resolve(config) {
        if (config.backend === 'auto') {
            // 'auto' should be resolved to a concrete backend by BrowserSessionRouter /
            // BrowserSessionManager before reaching here. Defensive fallback to local.
            console.warn('[BrowserBackendRouter] received backend=auto at resolve() — ' +
                'this should have been resolved by BrowserSessionManager via BrowserSessionRouter. ' +
                'Falling back to local.');
            const fallback = this.backends.get('local');
            if (!fallback)
                throw new Error('[BrowserBackendRouter] no local backend registered (auto fallback)');
            return fallback;
        }
        const b = this.backends.get(config.backend);
        if (!b)
            throw new Error(`[BrowserBackendRouter] no backend registered for type "${config.backend}"`);
        return b;
    }
    register(backend) {
        this.backends.set(backend.type, backend);
    }
}
exports.BrowserBackendRouter = BrowserBackendRouter;
//# sourceMappingURL=BrowserBackendRouter.js.map