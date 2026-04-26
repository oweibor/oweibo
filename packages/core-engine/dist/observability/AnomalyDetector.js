"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnomalyDetector = void 0;
const DEFAULT_THRESHOLDS = {
    maxRetriesPerStage: 3,
    maxTokensSimple: 10_000,
    maxTokensModerate: 30_000,
    maxTokensComplex: 80_000,
    maxToolCallsPerMinute: 60,
    maxToolCallsPerTask: 500,
    minTestPassRate: 0.8,
};
class AnomalyDetector {
    redis;
    thresholds;
    anomalies = [];
    constructor(redis, thresholds = {}) {
        this.redis = redis;
        this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    }
    checkRetries(traceId, taskId, retryCount) {
        if (retryCount <= this.thresholds.maxRetriesPerStage)
            return null;
        const severity = retryCount > this.thresholds.maxRetriesPerStage * 2
            ? 'escalation'
            : 'warning';
        return this.record({
            type: 'excessive-retries',
            severity,
            taskId,
            traceId,
            message: `Task ${taskId} has ${retryCount} retries (threshold: ${this.thresholds.maxRetriesPerStage})`,
            value: retryCount,
            threshold: this.thresholds.maxRetriesPerStage,
        });
    }
    checkTokenUsage(traceId, taskId, tokensUsed, complexity) {
        const thresholdMap = {
            simple: this.thresholds.maxTokensSimple,
            moderate: this.thresholds.maxTokensModerate,
            complex: this.thresholds.maxTokensComplex,
        };
        const threshold = thresholdMap[complexity] ?? this.thresholds.maxTokensComplex;
        if (tokensUsed <= threshold)
            return null;
        const severity = tokensUsed > threshold * 2 ? 'escalation' : 'warning';
        return this.record({
            type: 'token-overrun',
            severity,
            taskId,
            traceId,
            message: `Token usage ${tokensUsed} exceeds ${complexity} threshold ${threshold}`,
            value: tokensUsed,
            threshold,
        });
    }
    async checkToolInvocation(traceId, taskId, toolName) {
        if (!this.redis)
            return null;
        const minuteKey = `anomaly:tool-rate:${taskId}:${Math.floor(Date.now() / 60_000)}`;
        const taskKey = `anomaly:tool-total:${taskId}`;
        const [minuteCount, taskCount] = await Promise.all([
            this.redis.incr(minuteKey).then(async (n) => {
                if (n === 1)
                    await this.redis.expire(minuteKey, 120);
                return n;
            }),
            this.redis.incr(taskKey).then(async (n) => {
                if (n === 1)
                    await this.redis.expire(taskKey, 3600);
                return n;
            }),
        ]);
        if (minuteCount > this.thresholds.maxToolCallsPerMinute) {
            return this.record({
                type: 'tool-rate-limit',
                severity: 'critical',
                taskId,
                traceId,
                message: `Tool "${toolName}" invocations exceed ${this.thresholds.maxToolCallsPerMinute}/min for task ${taskId}`,
                value: minuteCount,
                threshold: this.thresholds.maxToolCallsPerMinute,
            });
        }
        if (taskCount > this.thresholds.maxToolCallsPerTask) {
            return this.record({
                type: 'tool-total-limit',
                severity: 'escalation',
                taskId,
                traceId,
                message: `Total tool invocations ${taskCount} exceeds task limit ${this.thresholds.maxToolCallsPerTask}`,
                value: taskCount,
                threshold: this.thresholds.maxToolCallsPerTask,
            });
        }
        return null;
    }
    checkTestPassRate(taskId, passed, total) {
        if (total === 0)
            return null;
        const rate = passed / total;
        if (rate >= this.thresholds.minTestPassRate)
            return null;
        return this.record({
            type: 'low-test-pass-rate',
            severity: rate < 0.5 ? 'escalation' : 'warning',
            taskId,
            message: `Test pass rate ${(rate * 100).toFixed(1)}% below threshold ${(this.thresholds.minTestPassRate * 100).toFixed(1)}%`,
            value: rate,
            threshold: this.thresholds.minTestPassRate,
        });
    }
    getAnomalies(taskId) {
        if (taskId)
            return this.anomalies.filter(a => a.taskId === taskId);
        return [...this.anomalies];
    }
    hasEscalation(taskId) {
        return this.anomalies.some(a => a.taskId === taskId && a.severity === 'escalation');
    }
    record(anomaly) {
        const entry = { ...anomaly, timestamp: Date.now() };
        this.anomalies.push(entry);
        const prefix = `[AnomalyDetector:${anomaly.severity.toUpperCase()}]`;
        if (anomaly.severity === 'warning') {
            console.warn(prefix, anomaly.message);
        }
        else {
            console.error(prefix, anomaly.message);
        }
        return entry;
    }
}
exports.AnomalyDetector = AnomalyDetector;
//# sourceMappingURL=AnomalyDetector.js.map