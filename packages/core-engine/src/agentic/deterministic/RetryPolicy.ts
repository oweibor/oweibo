// DONE: Phase A.11 — deterministic retry policy.
// Pure functions only — zero LLM calls, zero I/O.

export interface RetryPolicyConfig {
  maxAttempts:   number;     // total attempts (including first try)
  baseDelayMs:   number;     // initial backoff delay
  maxDelayMs:    number;     // cap on exponential backoff
  jitterFraction: number;    // fraction of delay to randomise (0–1)
}

export const DEFAULT_RETRY_POLICY: RetryPolicyConfig = {
  maxAttempts:    3,
  baseDelayMs:    500,
  maxDelayMs:    30_000,
  jitterFraction: 0.25,
};

export interface RetryDecision {
  shouldRetry:  boolean;
  delayMs:      number;
  /** The attempt number that just completed (1-based). */
  attempt:      number;
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
export function retryDecision(
  attempt:     number,
  error:       unknown,
  policy:      RetryPolicyConfig = DEFAULT_RETRY_POLICY,
  jitterSeed?: number,
): RetryDecision {
  const attemptsLeft = policy.maxAttempts - attempt;

  if (attemptsLeft <= 0) {
    return { shouldRetry: false, delayMs: 0, attempt, attemptsLeft: 0 };
  }

  if (isNonRetryableError(error)) {
    return { shouldRetry: false, delayMs: 0, attempt, attemptsLeft };
  }

  const exponential = Math.min(
    policy.baseDelayMs * 2 ** (attempt - 1),
    policy.maxDelayMs,
  );

  const jitter = policy.jitterFraction > 0
    ? (jitterSeed !== undefined
        ? deterministicJitter(jitterSeed, attempt, policy.jitterFraction)
        : Math.random() * policy.jitterFraction)
    : 0;

  // Apply maxDelayMs cap after jitter to ensure the bound is never exceeded.
  const delayMs = Math.min(Math.round(exponential * (1 + jitter)), policy.maxDelayMs);

  return { shouldRetry: true, delayMs, attempt, attemptsLeft };
}

/**
 * Non-retryable error classes — validation failures and auth errors should
 * not be retried as retrying won't change the outcome.
 */
function isNonRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes('validation') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('not found') ||
    msg.includes('invalid input')
  );
}

/**
 * Produces a deterministic jitter value in [0, fraction) from a seed and attempt.
 * Used in tests to avoid flakiness from Math.random().
 */
function deterministicJitter(seed: number, attempt: number, fraction: number): number {
  // Simple LCG-inspired hash to get a pseudo-random [0,1) value.
  const h = ((seed * 1664525 + attempt * 1013904223) >>> 0) / 0xFFFFFFFF;
  return h * fraction;
}

/**
 * Compute the total maximum wait across all retry attempts.
 * Useful for setting overall timeouts.
 */
export function maxTotalDelayMs(policy: RetryPolicyConfig = DEFAULT_RETRY_POLICY): number {
  let total = 0;
  for (let a = 1; a < policy.maxAttempts; a++) {
    total += Math.min(policy.baseDelayMs * 2 ** (a - 1), policy.maxDelayMs);
  }
  return Math.round(total * (1 + policy.jitterFraction));
}
