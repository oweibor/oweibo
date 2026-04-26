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

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  cooldownMs: 30_000,
  halfOpenMaxAttempts: 1,
  windowMs: 60_000,
};

interface CircuitData {
  state: CircuitState;
  failures: number;
  lastFailureAt: number;
  openedAt: number;
  halfOpenAttempts: number;
}

export class RedisCircuitBreaker {
  private readonly config: CircuitBreakerConfig;

  constructor(
    private readonly redis: Redis,
    private readonly stageId: string,
    config: Partial<CircuitBreakerConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private get key(): string {
    return `cb:${this.stageId}`;
  }

  async getState(): Promise<CircuitState> {
    const data = await this.getData();
    if (data.state === 'open') {
      const elapsed = Date.now() - data.openedAt;
      if (elapsed >= this.config.cooldownMs) {
        await this.transition('half_open');
        return 'half_open';
      }
    }
    return data.state;
  }

  async canExecute(): Promise<boolean> {
    const state = await this.getState();
    if (state === 'closed') return true;
    if (state === 'half_open') {
      const data = await this.getData();
      return data.halfOpenAttempts < this.config.halfOpenMaxAttempts;
    }
    return false;
  }

  async recordSuccess(): Promise<void> {
    const data = await this.getData();
    if (data.state === 'half_open') {
      await this.reset();
    } else {
      await this.setData({ ...data, failures: 0 });
    }
  }

  async recordFailure(error: IPipelineError): Promise<IRecoveryAction> {
    const data = await this.getData();
    const newFailures = data.failures + 1;
    const now = Date.now();

    if (data.state === 'half_open') {
      await this.transition('open');
      return {
        strategy: 'human-escalation',
        reason: `Circuit for ${this.stageId} re-opened after half-open failure: ${error.message}`,
      };
    }

    const windowExpired = now - data.lastFailureAt > this.config.windowMs;
    const effectiveFailures = windowExpired ? 1 : newFailures;

    if (effectiveFailures >= this.config.failureThreshold) {
      await this.setData({
        state: 'open',
        failures: effectiveFailures,
        lastFailureAt: now,
        openedAt: now,
        halfOpenAttempts: 0,
      });
      return this.selectRecovery(error, effectiveFailures);
    }

    await this.setData({
      ...data,
      failures: effectiveFailures,
      lastFailureAt: now,
    });
    return { strategy: 'retry', delayMs: 1000 * effectiveFailures, reason: error.message };
  }

  async reset(): Promise<void> {
    await this.setData({
      state: 'closed', failures: 0, lastFailureAt: 0,
      openedAt: 0, halfOpenAttempts: 0,
    });
  }

  private selectRecovery(error: IPipelineError, failures: number): IRecoveryAction {
    if (error.errorCode === 'LLM_HALLUCINATION') {
      return {
        strategy: 'context-reset',
        reason: `LLM hallucination detected in ${this.stageId} after ${failures} failures`,
        promptAugmentation: 'Previous attempt produced hallucinated output. Focus strictly on verified facts.',
      };
    }
    if (error.errorCode === 'GATE_FAILED' && failures <= 5) {
      return {
        strategy: 'architect-replan',
        reason: `Gate failure in ${this.stageId} — requesting architecture re-plan`,
      };
    }
    return {
      strategy: 'human-escalation',
      reason: `Circuit OPEN for ${this.stageId}: ${failures} consecutive failures`,
    };
  }

  private async transition(newState: CircuitState): Promise<void> {
    const data = await this.getData();
    await this.setData({
      ...data,
      state: newState,
      openedAt: newState === 'open' ? Date.now() : data.openedAt,
      halfOpenAttempts: newState === 'half_open' ? 0 : data.halfOpenAttempts,
    });
  }

  private async getData(): Promise<CircuitData> {
    const raw = await this.redis.get(this.key);
    if (!raw) {
      return { state: 'closed', failures: 0, lastFailureAt: 0, openedAt: 0, halfOpenAttempts: 0 };
    }
    return JSON.parse(raw) as CircuitData;
  }

  private async setData(data: CircuitData): Promise<void> {
    await this.redis.set(this.key, JSON.stringify(data), 'EX', 86400);
  }
}
