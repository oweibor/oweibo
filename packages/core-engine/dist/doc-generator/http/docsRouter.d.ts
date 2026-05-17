/**
 * docsRouter — Express router for /api/v1/docs/* endpoints (§4.3.4, v10.5).
 *
 * Endpoints:
 *   POST   /generate               Enqueue a doc-gen job
 *   GET    /status/:sessionId      Session phase + progress + warnings (paginated)
 *   GET    /stream/:sessionId      SSE stream of TaskEventBus events
 *   POST   /cancel/:sessionId      Signal cancellation
 *   GET    /openapi.json           OpenAPI 3.1 spec (unauthenticated)
 *
 * All responses include Content-Type: application/vnd.oweibo.docs.v1+json
 * and the schema version field (C9, v10.5).
 *
 * Rate limits, SETNX guard, idempotency, and daily quota are enforced
 * by DocGeneratorQueue — the router validates request shape and delegates.
 */
import { Router } from 'express';
import type { DocGeneratorQueue } from '../queue/DocGeneratorQueue.js';
import type { TaskEvent, TaskEventHandler } from '../../ingestion/TaskEventBus.js';
import type { AuditLogger } from '../observability/AuditLogger.js';
/** Minimal event-bus interface required by this router (HIGH-9). */
interface IDocEventBus {
    publish(sessionId: string, event: Omit<TaskEvent, 'timestamp'>): Promise<void>;
    subscribe(tenantId: string, sessionId: string, handler: TaskEventHandler): (() => void) | Promise<() => unknown>;
}
export declare function createDocsRouter(deps: {
    queue: DocGeneratorQueue;
    eventBus: IDocEventBus;
    audit: AuditLogger;
    /** Current concurrent doc-gen jobs on this pod — checked before enqueueing (MED-9). */
    getActiveJobCount?: () => number;
    /** Pod-level concurrency cap (MED-9). Default: 10. */
    maxConcurrentJobs?: number;
    /** Default output directory used when resolving download archives. */
    defaultOutputDir?: string;
}): Router;
export {};
//# sourceMappingURL=docsRouter.d.ts.map