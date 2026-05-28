/**
 * S.5.b (ttv-action-safety-v2): post-execution verification contract.
 *
 * A `PostExecutionVerifier` runs AFTER an action executes successfully
 * and independently checks that the action achieved its stated intent.
 * Two timings:
 *
 *   * `immediate`  — runs synchronously after the adapter returns, before
 *                    action_proposals.state flips to executed_live
 *   * `deferred`   — queued in oweibo.deferred_verifications and picked
 *                    up by the ApprovalLifecycleWorker on the next tick
 *                    after `deferredCheckAfterSeconds` elapses
 *
 * A verifier MAY declare either or both timings. The deferred function
 * MUST be idempotent (retries are possible after worker crashes).
 */
import type { ActionContext } from './IActionGate.js';
export type DriftSeverity = 0 | 1 | 2 | 3;
export interface VerificationOutcome {
    readonly severity: DriftSeverity;
    readonly expected: unknown;
    readonly observed: unknown;
    readonly diff?: unknown;
    /** Observed cost in USD cents — fed back to S.6 budget priors. */
    readonly observedCostCents?: number;
    /** Free-form note surfaced to the operator UI. */
    readonly notes?: string;
}
/**
 * Pure inputs that an immediate verifier receives. The `outcome` field
 * carries adapter-reported success metadata (e.g. inserted row count,
 * HTTP status, deployment version).
 */
export interface ImmediateVerifierInput {
    readonly ctx: ActionContext;
    readonly proposalId: string;
    readonly adapterOutcome: unknown;
}
/**
 * Deferred verifier inputs: the verifier_config persisted at queue-time,
 * plus the same proposalId + actionContext snapshot. The worker re-loads
 * the original action_context from action_proposals.payload when
 * invoking the deferred function.
 */
export interface DeferredVerifierInput {
    readonly tenantId: string;
    readonly proposalId: string;
    readonly verifierConfig: unknown;
    readonly expected: unknown;
}
export interface IPostExecutionVerifier {
    /** Stable identifier; persisted in post_execution_verifications.verifier_name. */
    readonly name: string;
    /** True iff this verifier should run for the given action class. */
    appliesTo(actionClass: string): boolean;
    /**
     * Synchronous post-adapter check. Returning a non-zero severity does NOT
     * automatically trigger rollback — that decision belongs to the
     * orchestrator using the per-tenant `auto_rollback_on_drift_severity`
     * policy. The verifier just reports.
     */
    immediate?(input: ImmediateVerifierInput): Promise<VerificationOutcome>;
    /**
     * Seconds after immediate completion at which the deferred check should
     * run. Defined iff `deferred` is defined. Worker tick granularity is
     * 30s; verifiers requiring sub-30s deferral are not supported.
     */
    readonly deferredCheckAfterSeconds?: number;
    /**
     * Idempotent re-runnable check. Worker retries on transient failure
     * with exponential backoff: 1m, 5m, 30m, 2h, 6h then failed_terminal.
     */
    deferred?(input: DeferredVerifierInput): Promise<VerificationOutcome>;
}
/**
 * Severity → recommended next-step mapping. Pure helper; the orchestrator
 * consults this when deciding whether to auto-rollback or escalate.
 *
 *   sev 0 — observed matches expected; no-op
 *   sev 1 — minor drift; logged + metric, no action
 *   sev 2 — material drift; notify owner + propose rollback (operator decides)
 *   sev 3 — significant drift; auto-rollback if policy allows, else block plan
 */
export declare function severityAction(sev: DriftSeverity): 'noop' | 'log' | 'notify' | 'rollback_or_block';
//# sourceMappingURL=IPostExecutionVerifier.d.ts.map