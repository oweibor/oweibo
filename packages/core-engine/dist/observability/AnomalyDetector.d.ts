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
export declare class AnomalyDetector {
    private readonly redis;
    private readonly thresholds;
    private readonly anomalies;
    constructor(redis: Redis | null, thresholds?: Partial<AnomalyThresholds>);
    checkRetries(traceId: string, taskId: string, retryCount: number): Anomaly | null;
    checkTokenUsage(traceId: string, taskId: string, tokensUsed: number, complexity: 'simple' | 'moderate' | 'complex'): Anomaly | null;
    checkToolInvocation(traceId: string, taskId: string, toolName: string): Promise<Anomaly | null>;
    checkTestPassRate(taskId: string, passed: number, total: number): Anomaly | null;
    getAnomalies(taskId?: string): Anomaly[];
    hasEscalation(taskId: string): boolean;
    private record;
}
//# sourceMappingURL=AnomalyDetector.d.ts.map