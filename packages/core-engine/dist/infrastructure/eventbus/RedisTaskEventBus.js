"use strict";
/**
 * RedisTaskEventBus — Redis pub/sub-backed TaskEventBus for multi-pod SSE (B3, v10.4).
 *
 * Uses separate pub/sub clients per Redis best practice. Events are namespaced
 * doc-events:{tenantId} and filtered by sessionId on the subscriber side.
 *
 * When mode=redis, this replaces the in-memory TaskEventBus for all doc-generator
 * session events. Wired in main.ts behind docs.generator.eventBus.mode flag.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisTaskEventBus = void 0;
class RedisTaskEventBus {
    pub;
    sub;
    logger;
    channelListeners = new Map();
    constructor(pub, sub, logger) {
        this.pub = pub;
        this.sub = sub;
        this.logger = logger;
    }
    async publish(sessionId, event) {
        const full = { ...event, timestamp: new Date().toISOString() };
        // Use the typed tenantId field directly (HIGH-8); do not dig into payload.
        const tenantId = event.tenantId ?? 'default';
        const channel = `doc-events:${tenantId}`;
        try {
            await this.pub.publish(channel, JSON.stringify(full));
        }
        catch (err) {
            this.logger.warn(`[RedisTaskEventBus] publish failed: ${err.message}`);
        }
    }
    subscribe(tenantId, sessionId, handler) {
        const channel = `doc-events:${tenantId}`;
        const listener = (ch, raw) => {
            if (ch !== channel)
                return;
            try {
                const event = JSON.parse(raw);
                if (event.taskId === sessionId)
                    void handler(event);
            }
            catch (err) {
                this.logger.warn(`[RedisTaskEventBus] parse error: ${err.message}`);
            }
        };
        if (!this.channelListeners.has(channel)) {
            this.channelListeners.set(channel, []);
            void this.sub.subscribe(channel);
        }
        this.channelListeners.get(channel).push(listener);
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
exports.RedisTaskEventBus = RedisTaskEventBus;
//# sourceMappingURL=RedisTaskEventBus.js.map