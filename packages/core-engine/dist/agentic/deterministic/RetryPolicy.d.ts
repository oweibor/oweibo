export interface RetryPolicyConfig {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    jitterFraction: number;
}
export declare const DEFAULT_RETRY_POLICY: RetryPolicyConfig;
export interface RetryDecision {
    shouldRetry: boolean;
    delayMs: number;
    /** The attempt number that just completed (1-based). */
    attempt: number;
    attemptsLeft: number;
}
/**
 * Decide whether to retry after a failed attempt.
 *
 * @param attempt 1-based number of the attempt that just failed.
 * @param error   The error thrown (used to check for non-retryable conditions).
 * @param policy  Retry configuration.
 * @returns       Retry decision with computed delay (jitter applied deterministically
 *                when jitterSeed is provided; otherwise Math.random() is used).
 */
export declare function retryDecision(attempt: number, error: unknown, policy?: RetryPolicyConfig, jitterSeed?: number): RetryDecision;
/**
 * Compute the total maximum wait across all retry attempts.
 * Useful for setting overall timeouts.
 */
export declare function maxTotalDelayMs(policy?: RetryPolicyConfig): number;
//# sourceMappingURL=RetryPolicy.d.ts.map