/**
 * tasks.routes.ts — REST API task routes (§5c.1).
 *
 * POST /tasks              — submit a new task
 * POST /tasks/:id/clarify  — respond to clarification questions
 * GET  /tasks/:id/events   — SSE stream of task events
 * POST /tasks/:id/redirect — mid-task intervention (redirect/pause/cancel)
 * GET  /tasks/:id          — get task status
 *
 * tenantId is NEVER accepted from the request body. It is always taken from
 * the authenticated JWT (req.tenantId injected by createAuthMiddleware).
 * This prevents a caller from escalating to another tenant's data.
 */
import { Router } from 'express';
export interface TaskRouteDeps {
    readonly intentPipeline: {
        submit(raw: {
            instruction: string;
            channel: string;
            userId?: string;
            sessionId?: string;
            tenantId: string;
            repoPath?: string;
            deliveryConfig?: unknown;
        }): Promise<{
            taskId: string;
            status: string;
            clarifyingQuestions?: Array<{
                id: string;
                question: string;
            }>;
        }>;
        clarify(taskId: string, answers: Record<string, string>, tenantId: string): Promise<{
            taskId: string;
            status: string;
        }>;
    };
    readonly taskEventBus: {
        subscribe(taskId: string, handler: (event: unknown) => void): () => void;
    };
    readonly interventionGateway: {
        submit(intervention: {
            taskId: string;
            type: string;
            payload?: string;
            source: string;
            userId?: string;
            tenantId: string;
        }): Promise<void>;
    };
    /** Optional: fetch task metadata for ownership checks. */
    readonly taskStore?: {
        getTenantId(taskId: string): Promise<string | null>;
    };
}
export declare function createTasksRouter(deps: TaskRouteDeps): Router;
export default createTasksRouter;
//# sourceMappingURL=tasks.routes.d.ts.map