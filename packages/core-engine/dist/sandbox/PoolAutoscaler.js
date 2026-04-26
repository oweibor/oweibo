"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PoolAutoscaler = void 0;
const DEFAULT_CONFIG = {
    minPoolSize: 2,
    maxPoolSize: 20,
    scaleUpThreshold: 0.8,
    scaleDownThreshold: 0.3,
    windowSize: 10,
    intervalMs: 30_000,
};
class PoolAutoscaler {
    redis;
    onScale;
    history = [];
    timer = null;
    config;
    constructor(redis, onScale, config = {}) {
        this.redis = redis;
        this.onScale = onScale;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    start() {
        if (this.timer)
            return;
        this.timer = setInterval(() => this.tick(), this.config.intervalMs);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    async tick() {
        const metrics = await this.collectMetrics();
        this.history.push(metrics);
        if (this.history.length > this.config.windowSize) {
            this.history.shift();
        }
        const forecast = this.forecast();
        const target = Math.max(this.config.minPoolSize, Math.min(this.config.maxPoolSize, forecast));
        const current = metrics.activeCount + metrics.idleCount;
        if (target !== current) {
            await this.onScale(target);
        }
    }
    async collectMetrics() {
        const pipeline = this.redis.pipeline();
        pipeline.get('pool:active');
        pipeline.get('pool:idle');
        pipeline.llen('pool:queue');
        pipeline.get('pool:avg_acquire_ms');
        pipeline.get('pool:avg_execution_ms');
        const results = await pipeline.exec();
        return {
            activeCount: parseInt(String(results?.[0]?.[1] ?? '0'), 10),
            idleCount: parseInt(String(results?.[1]?.[1] ?? '0'), 10),
            queueDepth: parseInt(String(results?.[2]?.[1] ?? '0'), 10),
            avgAcquireMs: parseFloat(String(results?.[3]?.[1] ?? '0')),
            avgExecutionMs: parseFloat(String(results?.[4]?.[1] ?? '0')),
        };
    }
    forecast() {
        if (this.history.length === 0)
            return this.config.minPoolSize;
        const avgUtilization = this.history.reduce((sum, m) => {
            const total = m.activeCount + m.idleCount;
            return sum + (total > 0 ? m.activeCount / total : 0);
        }, 0) / this.history.length;
        const avgQueueDepth = this.history.reduce((sum, m) => sum + m.queueDepth, 0) / this.history.length;
        const latest = this.history[this.history.length - 1]; // safe: length === 0 guard above
        const currentTotal = latest.activeCount + latest.idleCount;
        if (avgUtilization > this.config.scaleUpThreshold || avgQueueDepth > 1) {
            return Math.ceil(currentTotal * 1.5) + Math.ceil(avgQueueDepth);
        }
        if (avgUtilization < this.config.scaleDownThreshold && avgQueueDepth === 0) {
            return Math.max(this.config.minPoolSize, Math.floor(currentTotal * 0.7));
        }
        return currentTotal;
    }
}
exports.PoolAutoscaler = PoolAutoscaler;
//# sourceMappingURL=PoolAutoscaler.js.map