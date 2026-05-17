/**
 * DocGeneratorMetrics — OTEL counters + histograms for doc-gen runs (C7, v10.5).
 *
 * Uses @opentelemetry/api if available; gracefully degrades to no-ops otherwise.
 * Prometheus scrape is via the OTEL Prometheus exporter — wired externally.
 *
 * Metric names follow Prometheus naming conventions (MED-1): doc_gen_* prefix.
 *
 * Full metric inventory (15 metrics):
 *   doc_gen_runs_total               counter  — run completions by status
 *   doc_gen_run_duration_ms          histogram
 *   doc_gen_files_analyzed           histogram — files per run
 *   doc_gen_templates_rendered       histogram — templates per run
 *   doc_gen_warnings_total           counter
 *   doc_gen_llm_tokens_spent         histogram — tokens per run
 *   doc_gen_worker_slots             updown_counter — active concurrent jobs on pod
 *   doc_gen_queue_depth              updown_counter — jobs currently queued
 *   doc_gen_job_wait_time_ms         histogram — queued→running latency
 *   doc_gen_phase_duration_ms        histogram — per-phase duration
 *   doc_gen_cache_hits_total         counter
 *   doc_gen_cache_misses_total       counter
 *   doc_gen_llm_errors_total         counter
 *   doc_gen_cross_ref_broken_total   counter
 *   doc_gen_secrets_blocked_total    counter
 */
export declare class DocGeneratorMetrics {
    private readonly runsTotal;
    private readonly runDurationMs;
    private readonly filesAnalyzed;
    private readonly templatesRendered;
    private readonly warningsTotal;
    private readonly llmTokensSpent;
    private readonly workerSlots;
    private readonly queueDepth;
    private readonly jobWaitTimeMs;
    private readonly phaseDurationMs;
    private readonly cacheHitsTotal;
    private readonly cacheMissesTotal;
    private readonly llmErrorsTotal;
    private readonly crossRefBrokenTotal;
    private readonly secretsBlockedTotal;
    constructor();
    recordRunComplete(attrs: {
        tenantId: string;
        status: 'success' | 'failed' | 'cancelled';
        durationMs: number;
        filesAnalyzed: number;
        templatesRendered: number;
        warningCount: number;
        tokensSpent: number;
    }): void;
    recordWarning(tenantId: string, code: string): void;
    recordJobEnqueued(tenantId: string): void;
    recordJobDequeued(tenantId: string, waitMs: number): void;
    recordWorkerSlotAcquired(tenantId: string): void;
    recordWorkerSlotReleased(tenantId: string): void;
    recordPhase(phase: string, durationMs: number, tenantId: string): void;
    recordCacheHit(tenantId: string): void;
    recordCacheMiss(tenantId: string): void;
    recordLLMError(tenantId: string, phase: string): void;
    recordCrossRefBroken(tenantId: string): void;
    recordSecretBlocked(tenantId: string): void;
}
//# sourceMappingURL=DocGeneratorMetrics.d.ts.map