/**
 * RedisTaskEventBus — Redis pub/sub-backed TaskEventBus for multi-pod SSE (B3, v10.4).
 *
 * Uses separate pub/sub clients per Redis best practice. Events are namespaced
 * doc-events:{tenantId} and filtered by sessionId on the subscriber side.
 *
 * When mode=redis, this replaces the in-memory TaskEventBus for all doc-generator
 * session events. Wired in main.ts behind docs.generator.eventBus.mode flag.
 */

import type { TaskEvent, TaskEventHandler } from '../../ingestion/TaskEventBus.js';
import type { ILogger } from '../../doc-generator/analysis/validateGlobPatterns.js';

type RedisClient = {
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: 'message', handler: (channel: string, message: string) => void): void;
  off(event: 'message', handler: (channel: string, message: string) => void): void;
};

export class RedisTaskEventBus {
  private readonly channelListeners = new Map<
    string,
    Array<(channel: string, msg: string) => void>
  >();

  constructor(
    private readonly pub:    RedisClient,
    private readonly sub:    RedisClient,
    private readonly logger: ILogger,
  ) {}

  async publish(sessionId: string, event: Omit<TaskEvent, 'timestamp'>): Promise<void> {
    const full: TaskEvent = { ...event, timestamp: new Date().toISOString() };

    // Use the typed tenantId field directly (HIGH-8); do not dig into payload.
    const tenantId = event.tenantId ?? 'default';
    const channel  = `doc-events:${tenantId}`;

    try {
      await this.pub.publish(channel, JSON.stringify(full));
    } catch (err) {
      this.logger.warn(`[RedisTaskEventBus] publish failed: ${(err as Error).message}`);
    }
  }

  subscribe(
    tenantId:  string,
    sessionId: string,
    handler:   TaskEventHandler,
  ): () => void {
    const channel = `doc-events:${tenantId}`;

    const listener = (ch: string, raw: string) => {
      if (ch !== channel) return;
      try {
        const event = JSON.parse(raw) as TaskEvent;
        if (event.taskId === sessionId) void handler(event);
      } catch (err) {
        this.logger.warn(`[RedisTaskEventBus] parse error: ${(err as Error).message}`);
      }
    };

    if (!this.channelListeners.has(channel)) {
      this.channelListeners.set(channel, []);
      void this.sub.subscribe(channel);
    }
    this.channelListeners.get(channel)!.push(listener);
    this.sub.on('message', listener);

    return () => {
      this.sub.off('message', listener);
      const remaining = (this.channelListeners.get(channel) ?? []).filter((l) => l !== listener);
      this.channelListeners.set(channel, remaining);
      if (remaining.length === 0) {
        this.channelListeners.delete(channel);
        void this.sub.unsubscribe(channel);
      }
    };
  }
}
