"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScopedEventBus = void 0;
/**
 * ScopedEventBus — in-process typed event bus scoped to a single task/agent session.
 *
 * Used by the swarm for agent-to-agent communication (AgentMessage routing).
 * Each task gets its own ScopedEventBus instance — cross-task contamination is impossible.
 *
 * Backed by EventEmitter3 for performance; no Redis (that's TaskEventBus's responsibility).
 * Implements IScopedEventBus from core-contracts.
 */
const eventemitter3_1 = require("eventemitter3");
class ScopedEventBus {
    emit(_event, ..._args) { }
    on(_event, _handler) { }
    emitter = new eventemitter3_1.EventEmitter();
    taskId;
    constructor(taskId) {
        this.taskId = taskId;
    }
    publish(message) {
        const channel = message.to === 'broadcast'
            ? `${this.taskId}:broadcast`
            : `${this.taskId}:${message.to}`;
        this.emitter.emit(channel, message);
    }
    subscribe(agentId, handler) {
        const direct = `${this.taskId}:${agentId}`;
        const broadcast = `${this.taskId}:broadcast`;
        this.emitter.on(direct, handler);
        this.emitter.on(broadcast, handler);
        return () => {
            this.emitter.off(direct, handler);
            this.emitter.off(broadcast, handler);
        };
    }
    dispose() {
        this.emitter.removeAllListeners();
    }
}
exports.ScopedEventBus = ScopedEventBus;
//# sourceMappingURL=ScopedEventBus.js.map