/**
 * TaskEventBus — Redis pub/sub wrapper for TaskEventType events (v5).
 *
 * All pipeline progress events, swarm state changes, and general-coding
 * streaming events are published here. Consumers (REST SSE endpoint, CLI
 * progress renderer, ChannelEventBridge) subscribe to a per-session channel.
 *
 * Channel naming: `task-events:{sessionId}` — scoped to session, not task,
 * so that multi-task sessions receive a single unified event stream.
 *
 * Redis pub/sub is used (not streams) because events are ephemeral:
 * consumers must be connected at the time of publish. For durable delivery
 * the REST endpoint buffers recent events in a Redis list (not this class's concern).
 */
import type { TaskEventType } from '@oweibo/core-contracts';

export interface TaskEvent {
  readonly taskId:    string;
  readonly type:      TaskEventType | 'stage-started' | 'edit-applied' | 'verification-failed' | 'hitl-required' | 'task-accepted';
  readonly message:   string;
  readonly progress?: number;           // 0–100
  readonly payload?:  Record<string, unknown>;
  readonly timestamp?: string;          // ISO 8601 — set by publish() if absent
  /** Tenant scope — used by RedisTaskEventBus to route to the correct pub/sub channel (HIGH-8). */
  readonly tenantId?: string;
}

export type TaskEventHandler = (event: TaskEvent) => void | Promise<void>;

export class TaskEventBus {
  constructor(
    private readonly publish_: (channel: string, message: string) => Promise<void>,
    private readonly subscribe_: (
      channel: string,
      handler: (message: string) => void,
    ) => Promise<() => Promise<void>>,
  ) {}

  /**
   * publish — serialise and broadcast a TaskEvent to all subscribers of the session channel.
   */
  async publish(sessionId: string, event: Omit<TaskEvent, 'timestamp'>): Promise<void> {
    const full: TaskEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };
    await this.publish_(`task-events:${sessionId}`, JSON.stringify(full));
  }

  /**
   * subscribe — register a handler for all events on a session channel.
   * Returns an unsubscribe function; call it on cleanup.
   *
   * Overloads:
   *   subscribe(sessionId, handler)            — existing callers (tenantId unused for in-memory bus)
   *   subscribe(tenantId, sessionId, handler)  — docsRouter / RedisTaskEventBus-compatible signature (HIGH-9)
   */
  subscribe(tenantId: string, sessionId: string, handler: TaskEventHandler): Promise<() => Promise<void>>;
  subscribe(sessionId: string, handler: TaskEventHandler): Promise<() => Promise<void>>;
  subscribe(
    a: string,
    b: string | TaskEventHandler,
    c?: TaskEventHandler,
  ): Promise<() => Promise<void>> {
    const [sessionId, handler] =
      typeof b === 'function' ? [a, b] : [b, c!];
    return this.subscribe_(`task-events:${sessionId}`, (raw) => {
      try {
        const event = JSON.parse(raw) as TaskEvent;
        void handler(event);
      } catch {
        console.warn(`[TaskEventBus] Failed to parse event on session ${sessionId}: ${raw}`);
      }
    });
  }
}
