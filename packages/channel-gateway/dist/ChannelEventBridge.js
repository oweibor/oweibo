"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChannelEventBridge = void 0;
class ChannelEventBridge {
    eventBus;
    adapters;
    contextStore;
    queue = [];
    queueCapacity;
    concurrency;
    inFlight = 0;
    dropped = 0;
    constructor(eventBus, adapters, contextStore, options = {}) {
        this.eventBus = eventBus;
        this.adapters = adapters;
        this.contextStore = contextStore;
        this.queueCapacity = options.queueCapacity ?? 1024;
        this.concurrency = Math.max(1, options.concurrency ?? 4);
    }
    subscribe() {
        this.eventBus.onAny(async (event) => {
            // Fast path: skip early and synchronously if no taskId. No await, no I/O.
            if (!event.taskId)
                return;
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
    getDroppedCount() { return this.dropped; }
    drain() {
        while (this.inFlight < this.concurrency && this.queue.length > 0) {
            const next = this.queue.shift();
            if (!next)
                break;
            this.inFlight++;
            void this.dispatch(next).finally(() => {
                this.inFlight--;
                if (this.queue.length > 0)
                    setImmediate(() => this.drain());
            });
        }
    }
    async dispatch(event) {
        try {
            const raw = await this.contextStore
                .get(`task:${event.taskId}:channelReplyTarget`)
                .catch(() => null);
            if (!raw)
                return;
            const target = JSON.parse(raw);
            const adapter = this.adapters.get(target.platform);
            if (!adapter)
                return;
            // The raw botToken is stored transiently in the context store for routing;
            // the ChannelReplyTarget stored in IAgentTask only holds botTokenHash.
            const botToken = target['_botToken'] ?? '';
            const text = this.formatEvent(event);
            if (text === null) {
                await adapter.sendTypingIndicator?.(botToken, target.chatId);
            }
            else {
                await adapter.sendMessage(botToken, target.chatId, text);
            }
        }
        catch {
            // Adapter errors must never propagate back to the publisher.
        }
    }
    formatEvent(event) {
        switch (event.type) {
            case 'clarification-required':
                return `❓ *Clarification needed:*\n${(event.payload?.['questions'] ?? [])
                    .map((q) => `• ${q.question}`)
                    .join('\n')}`;
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
                return `🎉 *Done!* ${event.message}${event.payload?.['deliveryUrl'] && event.payload['deliveryUrl'] !== '[channel-reply]'
                    ? `\n📦 [Download](${event.payload['deliveryUrl']})`
                    : ''}`;
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
exports.ChannelEventBridge = ChannelEventBridge;
//# sourceMappingURL=ChannelEventBridge.js.map