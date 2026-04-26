/**
 * RedisCircuitBreaker — Redis-backed circuit breaker for pipeline stages (§5.4).
 *
 * States: CLOSED → OPEN (on failure threshold) → HALF_OPEN (after cooldown) → CLOSED.
 * State is persisted in Redis so it survives worker restarts.
 * Each pipeline stage has its own circuit keyed by `cb:{stageId}`.
 */
import type { Redis } from 'ioredis';
import type { IPipelineError, IRecoveryAction } from '@oweibo/core-contracts';
export type CircuitState = 'closed' | 'open' | 'half_open';
export interface CircuitBreakerConfig {
    readonly failureThreshold: number;
    readonly cooldownMs: number;
    readonly halfOpenMaxAttempts: number;
    readonly windowMs: number;
}
export declare class RedisCircuitBreaker {
    private readonly redis;
    private readonly stageId;
    private readonly config;
    constructor(redis: Redis, stageId: string, config?: Partial<CircuitBreakerConfig>);
    private get key();
    getState(): Promise<CircuitState>;
    canExecute(): Promise<boolean>;
    recordSuccess(): Promise<void>;
    recordFailure(error: IPipelineError): Promise<IRecoveryAction>;
    reset(): Promise<void>;
    private selectRecovery;
    private transition;
    private getData;
    private setData;
}
//# sourceMappingURL=RedisCircuitBreaker.d.ts.map