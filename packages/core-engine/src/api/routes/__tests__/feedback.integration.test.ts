// DONE: Phase A.7 — thumbs feedback end-to-end integration test
// Asserts: POST /tasks/:id/feedback → DB record → event published on event bus.
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createTasksRouter } from '../tasks.routes.js';
import type { TaskRouteDeps } from '../tasks.routes.js';

// ── Minimal authenticated-request middleware stub ─────────────────────────────

function stubAuth(tenantId: string, userId?: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    (req as unknown as Record<string, unknown>)['tenantId'] = tenantId;
    (req as unknown as Record<string, unknown>)['userId']   = userId;
    next();
  };
}

// ── Test helpers ─────────────────────────────────────────────────────────────

async function sendFeedback(
  app: ReturnType<typeof express>,
  taskId: string,
  signal: string,
  tenantId = 'tenant-123',
  userId   = 'user-abc',
): Promise<ReturnType<typeof import('supertest')>> {
  const supertest = await import('supertest');
  return (supertest.default ?? supertest)(app)
    .post(`/tasks/${taskId}/feedback`)
    .set('Content-Type', 'application/json')
    .send({ signal });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /tasks/:id/feedback (Phase A.7)', () => {
  const TASK_ID   = 'aaaaaaaa-1111-4111-a111-aaaaaaaaaaaa';
  const TENANT_ID = 'bbbbbbbb-2222-4222-b222-bbbbbbbbbbbb';
  const USER_ID   = 'cccccccc-3333-4333-c333-cccccccccccc';

  let publishedEvents: Array<{ subject: string; payload: unknown }>;
  let recordedFeedback: Array<{ taskId: string; tenantId: string; userId: string | undefined; signal: string }>;
  let app: ReturnType<typeof express>;

  beforeEach(() => {
    publishedEvents    = [];
    recordedFeedback   = [];

    const deps: TaskRouteDeps = {
      intentPipeline: {
        submit: jest.fn(),
        clarify: jest.fn(),
      },
      taskEventBus: {
        subscribe: jest.fn().mockReturnValue(() => {}),
      },
      interventionGateway: {
        submit: jest.fn(),
      },
      taskStore: {
        getTenantId: async (id) => (id === TASK_ID ? TENANT_ID : null),
        getStatus:   jest.fn(),
      },
      feedbackStore: {
        record: async (taskId, tenantId, userId, signal) => {
          recordedFeedback.push({ taskId, tenantId, userId, signal });
          return 'feedback-row-id-001';
        },
      },
      eventPublisher: {
        publish: async (subject, payload) => {
          publishedEvents.push({ subject, payload });
        },
      },
    };

    app = express();
    app.use(express.json());
    app.use(stubAuth(TENANT_ID, USER_ID));
    app.use('/tasks', createTasksRouter(deps));
  });

  it('returns 201 with taskId, signal, and feedbackId', async () => {
    const res = await sendFeedback(app, TASK_ID, 'thumbs_up', TENANT_ID, USER_ID);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      taskId:    TASK_ID,
      signal:    'thumbs_up',
      feedbackId: 'feedback-row-id-001',
    });
  });

  it('persists the feedback record via feedbackStore', async () => {
    await sendFeedback(app, TASK_ID, 'thumbs_down', TENANT_ID, USER_ID);
    expect(recordedFeedback).toHaveLength(1);
    expect(recordedFeedback[0]).toMatchObject({
      taskId:   TASK_ID,
      tenantId: TENANT_ID,
      userId:   USER_ID,
      signal:   'thumbs_down',
    });
  });

  it('publishes a task.feedback event on the event bus', async () => {
    await sendFeedback(app, TASK_ID, 'thumbs_up', TENANT_ID, USER_ID);
    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]).toMatchObject({
      subject: 'task.feedback',
      payload: {
        taskId:   TASK_ID,
        tenantId: TENANT_ID,
        signal:   'thumbs_up',
      },
    });
  });

  it('returns 404 for a task belonging to a different tenant', async () => {
    const res = await sendFeedback(app, 'other-task-id', 'thumbs_up', TENANT_ID, USER_ID);
    expect(res.status).toBe(404);
  });

  it('returns 400 for an invalid signal value', async () => {
    const res = await sendFeedback(app, TASK_ID, 'invalid_signal', TENANT_ID, USER_ID);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });
});
