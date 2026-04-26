/**
 * PoolAutoscaler — predictive autoscaler for sandbox warm pool (§7.4).
 *
 * Uses a moving-average forecast of sandbox demand to proactively scale
 * the warm pool. Reads metrics from Redis and adjusts pool size via
 * TieredWarmPoolManager. Runs on a configurable interval (default: 30s).
 */
import type { Redis } from 'ioredis';

export interface PoolMetrics {
  readonly activeCount: number;
  readonly idleCount: number;
  readonly queueDepth: number;
  readonly avgAcquireMs: number;
  readonly avgExecutionMs: number;
}

export interface AutoscaleConfig {
  readonly minPoolSize: number;
  readonly maxPoolSize: number;
  readonly scaleUpThreshold: number;
  readonly scaleDownThreshold: number;
  readonly windowSize: number;
  readonly intervalMs: number;
}

const DEFAULT_CONFIG: AutoscaleConfig = {
  minPoolSize: 2,
  maxPoolSize: 20,
  scaleUpThreshold: 0.8,
  scaleDownThreshold: 0.3,
  windowSize: 10,
  intervalMs: 30_000,
};

export class PoolAutoscaler {
  private readonly history: PoolMetrics[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly config: AutoscaleConfig;

  constructor(
    private readonly redis: Redis,
    private readonly onScale: (targetSize: number) => Promise<void>,
    config: Partial<AutoscaleConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.config.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    const metrics = await this.collectMetrics();
    this.history.push(metrics);
    if (this.history.length > this.config.windowSize) {
      this.history.shift();
    }

    const forecast = this.forecast();
    const target = Math.max(
      this.config.minPoolSize,
      Math.min(this.config.maxPoolSize, forecast),
    );

    const current = metrics.activeCount + metrics.idleCount;
    if (target !== current) {
      await this.onScale(target);
    }
  }

  private async collectMetrics(): Promise<PoolMetrics> {
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

  private forecast(): number {
    if (this.history.length === 0) return this.config.minPoolSize;

    const avgUtilization = this.history.reduce((sum, m) => {
      const total = m.activeCount + m.idleCount;
      return sum + (total > 0 ? m.activeCount / total : 0);
    }, 0) / this.history.length;

    const avgQueueDepth = this.history.reduce(
      (sum, m) => sum + m.queueDepth, 0,
    ) / this.history.length;

    const latest = this.history[this.history.length - 1]!;  // safe: length === 0 guard above
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
