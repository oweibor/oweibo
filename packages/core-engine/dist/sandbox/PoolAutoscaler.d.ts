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
export declare class PoolAutoscaler {
    private readonly redis;
    private readonly onScale;
    private readonly history;
    private timer;
    private readonly config;
    constructor(redis: Redis, onScale: (targetSize: number) => Promise<void>, config?: Partial<AutoscaleConfig>);
    start(): void;
    stop(): void;
    private tick;
    private collectMetrics;
    private forecast;
}
//# sourceMappingURL=PoolAutoscaler.d.ts.map