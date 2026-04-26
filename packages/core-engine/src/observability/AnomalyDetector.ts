/**
 * AnomalyDetector — token usage and tool invocation anomaly detection (§16c).
 *
 * Monitors per-task and per-stage resource consumption. Emits warnings and
 * escalation signals when anomalies exceed thresholds. Uses a sliding window
 * for rate limiting tool invocations.
 */
import type { Redis } from 'ioredis';

export type AnomalySeverity = 'warning' | 'critical' | 'escalation';

export interface Anomaly {
  readonly type: string;
  readonly severity: AnomalySeverity;
  readonly taskId: string;
  readonly traceId?: string;
  readonly message: string;
  readonly value: number;
  readonly threshold: number;
  readonly timestamp: number;
}

export interface AnomalyThresholds {
  readonly maxRetriesPerStage: number;
  readonly maxTokensSimple: number;
  readonly maxTokensModerate: number;
  readonly maxTokensComplex: number;
  readonly maxToolCallsPerMinute: number;
  readonly maxToolCallsPerTask: number;
  readonly minTestPassRate: number;
}

const DEFAULT_THRESHOLDS: AnomalyThresholds = {
  maxRetriesPerStage: 3,
  maxTokensSimple: 10_000,
  maxTokensModerate: 30_000,
  maxTokensComplex: 80_000,
  maxToolCallsPerMinute: 60,
  maxToolCallsPerTask: 500,
  minTestPassRate: 0.8,
};

export class AnomalyDetector {
  private readonly thresholds: AnomalyThresholds;
  private readonly anomalies: Anomaly[] = [];

  constructor(
    private readonly redis: Redis | null,
    thresholds: Partial<AnomalyThresholds> = {},
  ) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  checkRetries(traceId: string, taskId: string, retryCount: number): Anomaly | null {
    if (retryCount <= this.thresholds.maxRetriesPerStage) return null;

    const severity: AnomalySeverity = retryCount > this.thresholds.maxRetriesPerStage * 2
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

  checkTokenUsage(
    traceId: string,
    taskId: string,
    tokensUsed: number,
    complexity: 'simple' | 'moderate' | 'complex',
  ): Anomaly | null {
    const thresholdMap: Record<string, number> = {
      simple: this.thresholds.maxTokensSimple,
      moderate: this.thresholds.maxTokensModerate,
      complex: this.thresholds.maxTokensComplex,
    };
    const threshold = thresholdMap[complexity] ?? this.thresholds.maxTokensComplex;
    if (tokensUsed <= threshold) return null;

    const severity: AnomalySeverity = tokensUsed > threshold * 2 ? 'escalation' : 'warning';

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

  async checkToolInvocation(
    traceId: string,
    taskId: string,
    toolName: string,
  ): Promise<Anomaly | null> {
    if (!this.redis) return null;

    const minuteKey = `anomaly:tool-rate:${taskId}:${Math.floor(Date.now() / 60_000)}`;
    const taskKey = `anomaly:tool-total:${taskId}`;

    const [minuteCount, taskCount] = await Promise.all([
      this.redis.incr(minuteKey).then(async n => {
        if (n === 1) await this.redis!.expire(minuteKey, 120);
        return n;
      }),
      this.redis.incr(taskKey).then(async n => {
        if (n === 1) await this.redis!.expire(taskKey, 3600);
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

  checkTestPassRate(taskId: string, passed: number, total: number): Anomaly | null {
    if (total === 0) return null;
    const rate = passed / total;
    if (rate >= this.thresholds.minTestPassRate) return null;

    return this.record({
      type: 'low-test-pass-rate',
      severity: rate < 0.5 ? 'escalation' : 'warning',
      taskId,
      message: `Test pass rate ${(rate * 100).toFixed(1)}% below threshold ${(this.thresholds.minTestPassRate * 100).toFixed(1)}%`,
      value: rate,
      threshold: this.thresholds.minTestPassRate,
    });
  }

  getAnomalies(taskId?: string): Anomaly[] {
    if (taskId) return this.anomalies.filter(a => a.taskId === taskId);
    return [...this.anomalies];
  }

  hasEscalation(taskId: string): boolean {
    return this.anomalies.some(a => a.taskId === taskId && a.severity === 'escalation');
  }

  private record(anomaly: Omit<Anomaly, 'timestamp'>): Anomaly {
    const entry: Anomaly = { ...anomaly, timestamp: Date.now() };
    this.anomalies.push(entry);

    const prefix = `[AnomalyDetector:${anomaly.severity.toUpperCase()}]`;
    if (anomaly.severity === 'warning') {
      console.warn(prefix, anomaly.message);
    } else {
      console.error(prefix, anomaly.message);
    }

    return entry;
  }
}
