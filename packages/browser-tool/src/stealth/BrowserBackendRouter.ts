// packages/browser-tool/src/stealth/BrowserBackendRouter.ts
// Routes BrowserSessionConfig to the right IBrowserBackend implementation.
// Single source of truth for backend selection (§5.0).
//
// v9.5.9: resolveAsync() handles 'auto' by delegating to BrowserSessionRouter
//         before falling through to the existing backend map. The synchronous
//         resolve() retains its old semantics (defensive local fallback) so
//         callers that already resolved 'auto' via BrowserSessionManager continue
//         to work without changes.
import type { BrowserSessionConfig } from '@oweibo/core-contracts';
import type { IBrowserBackend, BrowserBackendType } from '../contracts/IBrowserBackend.js';
import type { BrowserSessionRouter, RoutingContext } from '../session/BrowserSessionRouter.js';

export class BrowserBackendRouter {
  constructor(
    private readonly backends: Map<BrowserBackendType, IBrowserBackend>,
    /** Optional — injected when the router should resolve 'auto' internally. */
    private readonly sessionRouter?: BrowserSessionRouter,
  ) {}

  /**
   * Async resolution — handles `backend === 'auto'` by consulting
   * BrowserSessionRouter when one is wired in, then falling through to
   * the existing backend map. Use this from new code paths.
   */
  async resolveAsync(
    config:     BrowserSessionConfig,
    routingCtx?: RoutingContext,
  ): Promise<IBrowserBackend> {
    if (config.backend === 'auto' && this.sessionRouter && routingCtx) {
      const decision = await this.sessionRouter.selectBackend(routingCtx);
      const b = this.backends.get(decision.backend);
      if (b) return b;
      // Router returned a backend that isn't registered; fall through to local.
    }
    return this.resolve(config);
  }

  /**
   * Synchronous resolution. `'auto'` must have been resolved to a concrete
   * backend by BrowserSessionManager before reaching here; if not, falls
   * back to 'local' with a warning (defensive).
   */
  resolve(config: BrowserSessionConfig): IBrowserBackend {
    if (config.backend === 'auto') {
      // 'auto' should be resolved to a concrete backend by BrowserSessionRouter /
      // BrowserSessionManager before reaching here. Defensive fallback to local.
      console.warn(
        '[BrowserBackendRouter] received backend=auto at resolve() — ' +
        'this should have been resolved by BrowserSessionManager via BrowserSessionRouter. ' +
        'Falling back to local.',
      );
      const fallback = this.backends.get('local');
      if (!fallback) throw new Error('[BrowserBackendRouter] no local backend registered (auto fallback)');
      return fallback;
    }
    const b = this.backends.get(config.backend);
    if (!b) throw new Error(`[BrowserBackendRouter] no backend registered for type "${config.backend}"`);
    return b;
  }

  register(backend: IBrowserBackend): void {
    this.backends.set(backend.type, backend);
  }
}
