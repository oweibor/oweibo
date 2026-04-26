import type { IChannelAdapter } from './adapters/IChannelAdapter.js';
import type { Platform } from '@oweibo/channel-contracts';
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
export declare class ChannelEventBridge {
    private readonly eventBus;
    private readonly adapters;
    private readonly contextStore;
    private readonly queue;
    private readonly queueCapacity;
    private readonly concurrency;
    private inFlight;
    private dropped;
    constructor(eventBus: ITaskEventBusGateway, adapters: Map<Platform, IChannelAdapter>, contextStore: IDistributedContextStoreGateway, options?: ChannelEventBridgeOptions);
    subscribe(): void;
    /** Number of events dropped due to queue overflow since process start. */
    getDroppedCount(): number;
    private drain;
    private dispatch;
    private formatEvent;
}
//# sourceMappingURL=ChannelEventBridge.d.ts.map