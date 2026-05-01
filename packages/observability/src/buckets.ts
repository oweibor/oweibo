/**
 * Histogram bucket boundaries for gen_ai.client.* metrics.
 * Emitted to the Prometheus-compatible OTel metrics exporter.
 */

// Token counts: input + output tokens per LLM call
export const TOKEN_BUCKETS: readonly number[] =
  [0, 100, 500, 1_000, 2_000, 5_000, 10_000, 50_000, 100_000];

// Call duration in milliseconds (chat + embeddings + agent stages)
export const DURATION_BUCKETS: readonly number[] =
  [10, 50, 100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000];

// Time-to-first-token for streaming responses
export const TTFT_BUCKETS: readonly number[] =
  [50, 100, 200, 500, 1_000, 2_000, 5_000];

// Time-per-output-token for streaming responses
export const TPOT_BUCKETS: readonly number[] =
  [5, 10, 25, 50, 100, 250, 500];
