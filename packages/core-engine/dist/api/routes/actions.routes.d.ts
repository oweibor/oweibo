/**
 * actions.routes.ts — T.−1 action trust ladder HTTP surface.
 *
 * GET    /actions/pending             — list pending action proposals
 * GET    /actions/history             — list non-pending proposals
 * GET    /actions/:id                 — fetch a single proposal with full payload
 * POST   /actions/:id/promote         — promote (success | failure outcome)
 * POST   /actions/:id/reject          — reject with reason
 * POST   /actions/shadow/outcome      — record a shadow execution outcome
 * GET    /actions/trust-matrix        — list explicit trust-state rows
 * POST   /actions/trust-matrix/pin    — pin a class to a mode
 * POST   /actions/trust-matrix/unpin  — clear a pin
 *
 * All routes are tenant-scoped via the JWT's tenantId claim — RLS in the
 * DryRunRegistry / ActionTrustLadder transactions enforces isolation.
 */
import { Router } from 'express';
import type { ActionTrustLadder } from '../../action/ActionTrustLadder.js';
import type { DryRunRegistry } from '../../action/DryRunRegistry.js';
import type { ShadowExecutor } from '../../action/ShadowExecutor.js';
export interface ActionsRouterDeps {
    trustLadder: ActionTrustLadder;
    registry: DryRunRegistry;
    shadowExecutor: ShadowExecutor;
}
export declare function createActionsRouter(deps: ActionsRouterDeps): Router;
//# sourceMappingURL=actions.routes.d.ts.map