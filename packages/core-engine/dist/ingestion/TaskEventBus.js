"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskEventBus = void 0;
class TaskEventBus {
    publish_;
    subscribe_;
    constructor(publish_, subscribe_) {
        this.publish_ = publish_;
        this.subscribe_ = subscribe_;
    }
    /**
     * publish — serialise and broadcast a TaskEvent to all subscribers of the session channel.
     */
    async publish(sessionId, event) {
        const full = {
            ...event,
            timestamp: new Date().toISOString(),
        };
        await this.publish_(`task-events:${sessionId}`, JSON.stringify(full));
    }
    subscribe(a, b, c) {
        const [sessionId, handler] = typeof b === 'function' ? [a, b] : [b, c];
        return this.subscribe_(`task-events:${sessionId}`, (raw) => {
            try {
                const event = JSON.parse(raw);
                void handler(event);
            }
            catch {
                console.warn(`[TaskEventBus] Failed to parse event on session ${sessionId}: ${raw}`);
            }
        });
    }
}
exports.TaskEventBus = TaskEventBus;
//# sourceMappingURL=TaskEventBus.js.map