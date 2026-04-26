// packages/channel-gateway/src/ChannelEventBridge.ts
// TaskEventBus → Platform reply (§21.9)
import type { IChannelAdapter } from './adapters/IChannelAdapter.js';
import type { Platform, ChannelReplyTarget } from '@oweibo/channel-contracts';
import type { TaskEventType } from '@oweibo/core-contracts';

export interface TaskEvent {
  type: TaskEventType | 'clarification-required' | 'stage-started' | 'intervention-applied';
  taskId?: string;
  message?: string;
  progress?: number;
  payload?: Record<string, unknown>;
}

export interface ITaskEventBusGateway {
  onAny(handler: (event: TaskEvent) => Promise<void>): void;
}

export interface IDistributedContextStoreGateway {
  get(key: string): Promise<string | null>;
}

/**
 * Subscribes to TaskEventBus and routes events to platform-native replies.
 * Only events whose taskId has a channelReplyTarget in DistributedContextStore produce messages.
 * REST API and CLI tasks produce no channel messages — the paths are fully orthogonal.
 *
 * Gap 7 (v9.5.2): the subscribe() handler enqueues events into an internal bounded
 * queue and returns immediately (microtask-fast). A background worker drains the
 * queue and performs the contextStore read + adapter.sendMessage off the caller's
 * stack, so TaskEventBus publishers are not blocked by channel I/O.
 */
export interface ChannelEventBridgeOptions {
  /** Maximum pending events before the bridge drops the oldest (default 1024). */
  readonly queueCapacity?: number;
  /** Maximum concurrent adapter dispatches (default 4). */
  readonly concurrency?: number;
}

export class ChannelEventBridge {
  private readonly queue: TaskEvent[] = [];
  private readonly queueCapacity: number;
  private readonly concurrency: number;
  private inFlight = 0;
  private dropped = 0;

  constructor(
    private readonly eventBus: ITaskEventBusGateway,
    private readonly adapters: Map<Platform, IChannelAdapter>,
    private readonly contextStore: IDistributedContextStoreGateway,
    options: ChannelEventBridgeOptions = {},
  ) {
    this.queueCapacity = options.queueCapacity ?? 1024;
    this.concurrency   = Math.max(1, options.concurrency ?? 4);
  }

  subscribe(): void {
    this.eventBus.onAny(async (event: TaskEvent): Promise<void> => {
      // Fast path: skip early and synchronously if no taskId. No await, no I/O.
      if (!event.taskId) return;

      if (this.queue.length >= this.queueCapacity) {
        // Drop-oldest backpressure — preserves recency for operational events.
        this.queue.shift();
        this.dropped++;
      }
      this.queue.push(event);
      // Schedule drain on the next tick so publishers return immediately.
      setImmediate(() => this.drain());
    });
  }

  /** Number of events dropped due to queue overflow since process start. */
  getDroppedCount(): number { return this.dropped; }

  private drain(): void {
    while (this.inFlight < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      this.inFlight++;
      void this.dispatch(next).finally(() => {
        this.inFlight--;
        if (this.queue.length > 0) setImmediate(() => this.drain());
      });
    }
  }

  private async dispatch(event: TaskEvent): Promise<void> {
    try {
      const raw = await this.contextStore
        .get(`task:${event.taskId}:channelReplyTarget`)
        .catch(() => null);
      if (!raw) return;

      const target: ChannelReplyTarget & { botToken?: string } = JSON.parse(raw);
      const adapter = this.adapters.get(target.platform);
      if (!adapter) return;

      // The raw botToken is stored transiently in the context store for routing;
      // the ChannelReplyTarget stored in IAgentTask only holds botTokenHash.
      const botToken = (target as unknown as { _botToken?: string })['_botToken'] ?? '';

      const text = this.formatEvent(event);
      if (text === null) {
        await adapter.sendTypingIndicator?.(botToken, target.chatId);
      } else {
        await adapter.sendMessage(botToken, target.chatId, text);
      }
    } catch {
      // Adapter errors must never propagate back to the publisher.
    }
  }

  private formatEvent(event: TaskEvent): string | null {
    switch (event.type) {
      case 'clarification-required':
        return `❓ *Clarification needed:*\n${
          ((event.payload?.['questions'] ?? []) as Array<{ question: string }>)
            .map((q) => `• ${q.question}`)
            .join('\n')
        }`;
      case 'task-accepted':
        return `✅ Got it — I'll keep you updated as work progresses.`;
      case 'stage-started':
        return null; // typing indicator only
      case 'stage-completed':
        return `🔄 ${event.message ?? 'Stage complete'} (${event.progress ?? 0}%)`;
      case 'plan-ready':
        return `📋 *Plan ready:*\n${event.message}\n\nReply \`/approve ${event.taskId}\` to proceed or \`/cancel ${event.taskId}\` to abort.`;
      case 'intervention-applied':
        return `↩️ ${event.message}`;
      case 'output-ready':
        return `🎉 *Done!* ${event.message}${
          event.payload?.['deliveryUrl'] && event.payload['deliveryUrl'] !== '[channel-reply]'
            ? `\n📦 [Download](${event.payload['deliveryUrl'] as string})`
            : ''
        }`;
      case 'task-failed':
        return `❌ Task failed: ${event.message}`;
      // ── v9.5: Reactive Orchestrator events ──────────────────────────────
      case 'plan-node-dispatched':
        return null; // typing indicator only — keep channel message noise low
      case 'plan-node-complete':
        return null; // intermediate progress — suppress per-node noise on channel
      case 'plan-amended':
        return `🔀 Plan updated: ${event.message}`;
      case 'synthesis-started':
        return null; // typing indicator only
      // ── v9.5.1: Specialist spawning ──────────────────────────────────────
      case 'specialist-spawned':
        return `🤖 ${event.message}`;
      default:
        return null;
    }
  }
}
