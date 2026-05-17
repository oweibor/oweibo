/**
 * platform.routes.ts — Platform governance routes (§17.5.1, §18.8.3, §9.5).
 *
 * GET  /platform/operational-mode         — current mode state + transition history
 * POST /platform/operational-mode         — set mode (platform:admin)
 * GET  /platform/charter/thresholds       — current drift threshold config + recent events
 * POST /platform/charter/thresholds       — update thresholds (platform:admin)
 * GET  /platform/promotions/pending       — list arms awaiting human approval (D.6)
 * GET  /platform/promotions/recent        — recent approve/reject history (D.6)
 * POST /platform/promotions/decide        — approve or reject a promotion (platform:admin)
 *
 * Scope guard: POST endpoints require 'platform:admin' in the JWT scopes claim.
 * If scopes are absent (older tokens), fall back to PLATFORM_ADMIN_KEY header.
 */
import { Router } from 'express';
import type { Pool } from 'pg';
import { OperationalModeService } from '../../infrastructure/OperationalModeService.js';
import type { PromotionGateService } from '../../bandit/PromotionGateService.js';
export declare function createPlatformRouter(deps: {
    pool: Pool;
    operationalMode: OperationalModeService;
    promotionGate?: PromotionGateService;
}): Router;
//# sourceMappingURL=platform.routes.d.ts.map