"use strict";
/**
 * Histogram bucket boundaries for gen_ai.client.* metrics.
 * Emitted to the Prometheus-compatible OTel metrics exporter.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TPOT_BUCKETS = exports.TTFT_BUCKETS = exports.DURATION_BUCKETS = exports.TOKEN_BUCKETS = void 0;
// Token counts: input + output tokens per LLM call
exports.TOKEN_BUCKETS = [0, 100, 500, 1_000, 2_000, 5_000, 10_000, 50_000, 100_000];
// Call duration in milliseconds (chat + embeddings + agent stages)
exports.DURATION_BUCKETS = [10, 50, 100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000];
// Time-to-first-token for streaming responses
exports.TTFT_BUCKETS = [50, 100, 200, 500, 1_000, 2_000, 5_000];
// Time-per-output-token for streaming responses
exports.TPOT_BUCKETS = [5, 10, 25, 50, 100, 250, 500];
//# sourceMappingURL=buckets.js.map