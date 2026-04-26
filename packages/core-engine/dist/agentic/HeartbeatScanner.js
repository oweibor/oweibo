"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HeartbeatScanner = void 0;
const DEFAULT_CONFIG = {
    scanIntervalMs: 10_000,
    heartbeatTimeoutMs: 60_000,
    maxStallBeforeEscalation: 3,
};
class HeartbeatScanner {
    redis;
    onStalled;
    onEscalate;
    timer = null;
    stallCounts = new Map();
    config;
    constructor(redis, onStalled, onEscalate, config = {}) {
        this.redis = redis;
        this.onStalled = onStalled;
        this.onEscalate = onEscalate;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    start() {
        if (this.timer)
            return;
        this.timer = setInterval(() => this.scan(), this.config.scanIntervalMs);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    async scan() {
        const now = Date.now();
        const stalled = [];
        // Scan all heartbeat keys
        const keys = await this.redis.keys('heartbeat:task:*');
        for (const key of keys) {
            const data = await this.redis.hgetall(key);
            if (!data.lastBeat)
                continue;
            const lastHeartbeat = parseInt(data.lastBeat, 10);
            const elapsed = now - lastHeartbeat;
            if (elapsed > this.config.heartbeatTimeoutMs) {
                const taskId = key.replace('heartbeat:task:', '');
                const stalledTask = {
                    taskId,
                    lastHeartbeat,
                    stalledForMs: elapsed,
                    currentStage: data.stage ?? 'unknown',
                    workerId: data.workerId ?? 'unknown',
                };
                const count = (this.stallCounts.get(taskId) ?? 0) + 1;
                this.stallCounts.set(taskId, count);
                if (count >= this.config.maxStallBeforeEscalation) {
                    await this.onEscalate(stalledTask);
                    this.stallCounts.delete(taskId);
                }
                else {
                    await this.onStalled(stalledTask);
                }
                stalled.push(stalledTask);
            }
        }
        return stalled;
    }
    clearStallCount(taskId) {
        this.stallCounts.delete(taskId);
    }
}
exports.HeartbeatScanner = HeartbeatScanner;
//# sourceMappingURL=HeartbeatScanner.js.map