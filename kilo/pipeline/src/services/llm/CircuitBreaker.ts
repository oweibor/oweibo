/**
 * Reusable circuit breaker class.
 * Extracted from the Ollama-specific singleton so each LLM provider
 * can maintain its own independent fault-isolation window.
 *
 * States: CLOSED (normal) → OPEN (tripped) → HALF_OPEN (probing) → CLOSED
 *
 * @module services/llm/CircuitBreaker
 */

const logger = require('../logger');
const metrics = require('../metrics');

export interface CircuitBreakerConfig {
    windowSize: number;
    failureThreshold: number;   // 0.0–1.0
    resetTimeoutMs: number;
}

type CBState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

const STATE_MAP: Record<CBState, number> = { CLOSED: 0, OPEN: 1, HALF_OPEN: 2 };
const MAX_BACKOFF_MS = 30 * 60 * 1_000; // 30-minute hard cap

class CircuitBreaker {
    private state: CBState = 'CLOSED';
    private resultsWindow: boolean[] = [];
    private resetTimer: ReturnType<typeof setTimeout> | null = null;
    private probeActive = false;
    private tripCount = 0;

    constructor(private readonly cfg: CircuitBreakerConfig) {}

    getState(): CBState { return this.state; }

    getFailureRate(): number {
        if (this.resultsWindow.length === 0) return 0;
        const failures = this.resultsWindow.filter(r => !r).length;
        return failures / this.resultsWindow.length;
    }

    isCallAllowed(): boolean {
        if (this.state === 'CLOSED') return true;
        if (this.state === 'OPEN') return false;
        // HALF_OPEN — allow exactly one probe
        if (this.probeActive) return false;
        this.probeActive = true;
        return true;
    }

    recordSuccess(): void {
        if (this.state === 'HALF_OPEN') {
            logger.info('Circuit breaker probe SUCCEEDED');
            this.reset();
            return;
        }
        this.push(true);
        if (
            this.tripCount > 0 &&
            this.resultsWindow.length >= this.cfg.windowSize &&
            this.resultsWindow.every(r => r)
        ) {
            logger.info('Circuit breaker fully stable — resetting trip backoff');
            this.tripCount = 0;
        }
    }

    recordFailure(): void {
        if (this.state === 'HALF_OPEN') {
            logger.warn('Circuit breaker probe FAILED');
            this.trip();
            return;
        }
        this.push(false);
        if (this.resultsWindow.length >= 3 && this.getFailureRate() >= this.cfg.failureThreshold) {
            this.trip();
        }
    }

    // For test teardown only
    _resetState(): void {
        this.state = 'CLOSED';
        this.resultsWindow = [];
        this.probeActive = false;
        this.tripCount = 0;
        if (this.resetTimer) clearTimeout(this.resetTimer);
        this.resetTimer = null;
    }

    private push(result: boolean): void {
        this.resultsWindow.push(result);
        if (this.resultsWindow.length > this.cfg.windowSize) this.resultsWindow.shift();
    }

    private trip(): void {
        if (this.state === 'OPEN') return;
        this.tripCount += 1;
        this.state = 'OPEN';
        const effectiveTimeout = Math.min(
            this.cfg.resetTimeoutMs * Math.pow(2, this.tripCount - 1),
            MAX_BACKOFF_MS
        );
        logger.warn('Circuit breaker TRIPPED (OPEN)', {
            failure_rate: this.getFailureRate().toFixed(2),
            window: this.resultsWindow.length,
            trip_count: this.tripCount,
            timeout_s: effectiveTimeout / 1_000,
        });
        metrics.circuitState.set(STATE_MAP.OPEN);
        if (this.resetTimer) clearTimeout(this.resetTimer);
        this.resetTimer = setTimeout(() => {
            this.state = 'HALF_OPEN';
            this.probeActive = false;
            logger.info('Circuit breaker → HALF_OPEN (probe ready)', { trip_count: this.tripCount });
            metrics.circuitState.set(STATE_MAP.HALF_OPEN);
        }, effectiveTimeout);
    }

    private reset(): void {
        this.state = 'CLOSED';
        this.resultsWindow = [];
        this.probeActive = false;
        if (this.resetTimer) clearTimeout(this.resetTimer);
        this.resetTimer = null;
        logger.info('Circuit breaker RESET (CLOSED)', { trip_count: this.tripCount });
        metrics.circuitState.set(STATE_MAP.CLOSED);
    }
}

module.exports = { CircuitBreaker };

export {};
