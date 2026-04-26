"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskHeartbeat = void 0;
class TaskHeartbeat {
    redis;
    static HEARTBEAT_KEY = (taskId) => `task:${taskId}:heartbeat`;
    static HEARTBEAT_TTL_SEC = 30;
    timers = new Map();
    constructor(redis) {
        this.redis = redis;
    }
    async start(taskId, sessionId) {
        await this.beat(taskId);
        const timer = setInterval(async () => {
            await this.beat(taskId);
        }, 15_000);
        this.timers.set(taskId, timer);
    }
    async cancel(taskId) {
        const timer = this.timers.get(taskId);
        if (timer) {
            clearInterval(timer);
            this.timers.delete(taskId);
        }
        await this.redis.del(TaskHeartbeat.HEARTBEAT_KEY(taskId));
    }
    async beat(taskId) {
        await this.redis.setex(TaskHeartbeat.HEARTBEAT_KEY(taskId), TaskHeartbeat.HEARTBEAT_TTL_SEC, Date.now().toString());
    }
}
exports.TaskHeartbeat = TaskHeartbeat;
//# sourceMappingURL=TaskHeartbeat.js.map