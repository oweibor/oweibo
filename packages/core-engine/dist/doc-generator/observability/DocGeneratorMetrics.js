"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocGeneratorMetrics = void 0;
// Dynamic import so the package is optional
let meter;
const noop = {
    counter: { add: () => undefined },
    upDownCounter: { add: () => undefined },
    histogram: { record: () => undefined },
};
function tryGetMeter() {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const otel = require('@opentelemetry/api');
        return otel.metrics.getMeter('doc_gen');
    }
    catch {
        return undefined;
    }
}
class DocGeneratorMetrics {
    runsTotal;
    runDurationMs;
    filesAnalyzed;
    templatesRendered;
    warningsTotal;
    llmTokensSpent;
    workerSlots;
    queueDepth;
    jobWaitTimeMs;
    phaseDurationMs;
    cacheHitsTotal;
    cacheMissesTotal;
    llmErrorsTotal;
    crossRefBrokenTotal;
    secretsBlockedTotal;
    constructor() {
        meter = meter ?? tryGetMeter();
        this.runsTotal = meter?.createCounter('doc_gen_runs_total', { description: 'Total doc-gen run completions' }) ?? noop.counter;
        this.runDurationMs = meter?.createHistogram('doc_gen_run_duration_ms', { description: 'Doc-gen run duration', unit: 'ms' }) ?? noop.histogram;
        this.filesAnalyzed = meter?.createHistogram('doc_gen_files_analyzed', { description: 'Files analyzed per run' }) ?? noop.histogram;
        this.templatesRendered = meter?.createHistogram('doc_gen_templates_rendered', { description: 'Templates rendered per run' }) ?? noop.histogram;
        this.warningsTotal = meter?.createCounter('doc_gen_warnings_total', { description: 'Total doc-gen warnings emitted' }) ?? noop.counter;
        this.llmTokensSpent = meter?.createHistogram('doc_gen_llm_tokens_spent', { description: 'LLM tokens spent per run' }) ?? noop.histogram;
        this.workerSlots = meter?.createUpDownCounter('doc_gen_worker_slots', { description: 'Active concurrent doc-gen jobs on this pod' }) ?? noop.upDownCounter;
        this.queueDepth = meter?.createUpDownCounter('doc_gen_queue_depth', { description: 'Jobs currently waiting in the doc-gen queue' }) ?? noop.upDownCounter;
        this.jobWaitTimeMs = meter?.createHistogram('doc_gen_job_wait_time_ms', { description: 'Time from job enqueue to first pick-up', unit: 'ms' }) ?? noop.histogram;
        this.phaseDurationMs = meter?.createHistogram('doc_gen_phase_duration_ms', { description: 'Duration of individual analysis/rendering phases', unit: 'ms' }) ?? noop.histogram;
        this.cacheHitsTotal = meter?.createCounter('doc_gen_cache_hits_total', { description: 'Analysis cache hits' }) ?? noop.counter;
        this.cacheMissesTotal = meter?.createCounter('doc_gen_cache_misses_total', { description: 'Analysis cache misses' }) ?? noop.counter;
        this.llmErrorsTotal = meter?.createCounter('doc_gen_llm_errors_total', { description: 'LLM call failures during doc-gen' }) ?? noop.counter;
        this.crossRefBrokenTotal = meter?.createCounter('doc_gen_cross_ref_broken_total', { description: 'Broken cross-references detected in rendered output' }) ?? noop.counter;
        this.secretsBlockedTotal = meter?.createCounter('doc_gen_secrets_blocked_total', { description: 'Secret patterns redacted from rendered output' }) ?? noop.counter;
    }
    recordRunComplete(attrs) {
        const a = { tenant_id: attrs.tenantId, status: attrs.status };
        this.runsTotal.add(1, a);
        this.runDurationMs.record(attrs.durationMs, a);
        this.filesAnalyzed.record(attrs.filesAnalyzed, a);
        this.templatesRendered.record(attrs.templatesRendered, a);
        this.warningsTotal.add(attrs.warningCount, a);
        this.llmTokensSpent.record(attrs.tokensSpent, a);
    }
    recordWarning(tenantId, code) {
        this.warningsTotal.add(1, { tenant_id: tenantId, warning_code: code });
    }
    recordJobEnqueued(tenantId) {
        this.queueDepth.add(1, { tenant_id: tenantId });
    }
    recordJobDequeued(tenantId, waitMs) {
        this.queueDepth.add(-1, { tenant_id: tenantId });
        this.jobWaitTimeMs.record(waitMs, { tenant_id: tenantId });
    }
    recordWorkerSlotAcquired(tenantId) {
        this.workerSlots.add(1, { tenant_id: tenantId });
    }
    recordWorkerSlotReleased(tenantId) {
        this.workerSlots.add(-1, { tenant_id: tenantId });
    }
    recordPhase(phase, durationMs, tenantId) {
        this.phaseDurationMs.record(durationMs, { phase, tenant_id: tenantId });
    }
    recordCacheHit(tenantId) { this.cacheHitsTotal.add(1, { tenant_id: tenantId }); }
    recordCacheMiss(tenantId) { this.cacheMissesTotal.add(1, { tenant_id: tenantId }); }
    recordLLMError(tenantId, phase) { this.llmErrorsTotal.add(1, { tenant_id: tenantId, phase }); }
    recordCrossRefBroken(tenantId) { this.crossRefBrokenTotal.add(1, { tenant_id: tenantId }); }
    recordSecretBlocked(tenantId) { this.secretsBlockedTotal.add(1, { tenant_id: tenantId }); }
}
exports.DocGeneratorMetrics = DocGeneratorMetrics;
//# sourceMappingURL=DocGeneratorMetrics.js.map