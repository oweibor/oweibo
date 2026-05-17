/**
 * hitl.routes.ts — HITL (Human-In-The-Loop) approval routes (§5c.1).
 *
 * POST /hitl/:requestId/approve — approve a HITL escalation
 * POST /hitl/:requestId/reject  — reject a HITL escalation
 * GET  /hitl/pending             — list pending HITL requests
 *
 * tenantId is NEVER accepted from query params. It is always taken from
 * the authenticated JWT (req.tenantId injected by createAuthMiddleware).
 * This prevents a caller from listing or acting on another tenant's requests.
 */
import { Router } from 'express';
export interface HITLRouteDeps {
    readonly hitlGateway: {
        approve(requestId: string, decision: {
            reason?: string;
            modifications?: Record<string, unknown>;
            userId?: string;
            tenantId: string;
        }): Promise<void>;
        reject(requestId: string, decision: {
            reason?: string;
            userId?: string;
            tenantId: string;
        }): Promise<void>;
        listPending(tenantId: string): Promise<Array<{
            requestId: string;
            taskId: string;
            agentId: string;
            reason: string;
            escalatedAt: number;
        }>>;
    };
}
export declare function createHITLRouter(deps: HITLRouteDeps): Router;
export default createHITLRouter;
//# sourceMappingURL=hitl.routes.d.ts.map