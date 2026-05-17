/**
 * tasks.routes.ts — REST API task routes (§5c.1).
 *
 * POST /tasks              — submit a new task
 * POST /tasks/:id/clarify  — respond to clarification questions
 * GET  /tasks/:id/events   — SSE stream of task events
 * POST /tasks/:id/redirect — mid-task intervention (redirect/pause/cancel/add-constraint)
 * GET  /tasks/:id          — get task status (stage, progress, timestamps, error)
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
    /** Optional: fetch task metadata for ownership checks and status. */
    readonly taskStore?: {
        getTenantId(taskId: string): Promise<string | null>;
        getStatus(taskId: string): Promise<{
            status: string;
            stage?: string;
            progress?: number;
            startedAt?: string;
            completedAt?: string;
            error?: string;
        } | null>;
    };
    /** Phase A.7: thumbs feedback persistence + event emission. */
    readonly feedbackStore?: {
        record(taskId: string, tenantId: string, userId: string | undefined, signal: 'thumbs_up' | 'thumbs_down'): Promise<string>;
    };
    readonly eventPublisher?: {
        publish(subject: string, payload: unknown): Promise<void>;
    };
}
export declare function createTasksRouter(deps: TaskRouteDeps): Router;
export default createTasksRouter;
//# sourceMappingURL=tasks.routes.d.ts.map