/**
 * Ollama circuit breaker singleton.
 *
 * Thin wrapper around CircuitBreaker class that applies hardware-aware
 * thresholds from HARDWARE_PROFILE. Existing callers (client.ts, health route)
 * consume the module-level API unchanged.
 *
 * @module services/ollama/circuitBreaker
 */

const config = require('../../config');
const { CircuitBreaker } = require('../llm/CircuitBreaker');

import { CircuitBreakerConfig } from '../llm/CircuitBreaker';

const hardwareProfile: string = config.HARDWARE_PROFILE || 'n100_like';

const PROFILE_THRESHOLDS: Record<string, CircuitBreakerConfig> = {
    // Low-power Intel
    n100_like:      { windowSize: 10, failureThreshold: 0.15, resetTimeoutMs: 300_000 },
    celeron:        { windowSize: 10, failureThreshold: 0.20, resetTimeoutMs: 300_000 },

    // Standard Intel
    core_i3:        { windowSize: 15, failureThreshold: 0.25, resetTimeoutMs: 180_000 },
    core_i5:        { windowSize: 20, failureThreshold: 0.30, resetTimeoutMs: 120_000 },
    core_i7:        { windowSize: 20, failureThreshold: 0.35, resetTimeoutMs: 120_000 },

    // AMD
    amd_low:        { windowSize: 10, failureThreshold: 0.15, resetTimeoutMs: 300_000 },
    amd_mid:        { windowSize: 15, failureThreshold: 0.25, resetTimeoutMs: 180_000 },
    amd_high:       { windowSize: 20, failureThreshold: 0.35, resetTimeoutMs: 120_000 },

    // ARM
    arm64_rpi5:     { windowSize: 10, failureThreshold: 0.20, resetTimeoutMs: 300_000 },
    arm64_server:   { windowSize: 15, failureThreshold: 0.25, resetTimeoutMs: 180_000 },

    // GPU-accelerated
    nvidia_small:   { windowSize: 15, failureThreshold: 0.30, resetTimeoutMs: 180_000 },
    nvidia_medium:  { windowSize: 20, failureThreshold: 0.35, resetTimeoutMs: 120_000 },
    nvidia_large:   { windowSize: 20, failureThreshold: 0.40, resetTimeoutMs:  60_000 },

    // Apple Silicon
    apple_silicon:  { windowSize: 20, failureThreshold: 0.35, resetTimeoutMs: 120_000 },
};

const cbConfig: CircuitBreakerConfig =
    PROFILE_THRESHOLDS[hardwareProfile] ?? PROFILE_THRESHOLDS['n100_like'];

const instance = new CircuitBreaker(cbConfig);

// Flat API — identical to the previous module-level exports so all callers
// (client.ts, routes/health.ts, tests) need zero changes.
module.exports = {
    getState:       () => instance.getState(),
    getFailureRate: () => instance.getFailureRate(),
    recordSuccess:  () => instance.recordSuccess(),
    recordFailure:  () => instance.recordFailure(),
    isCallAllowed:  () => instance.isCallAllowed(),
    _resetState:    () => instance._resetState(),
};

export {};
