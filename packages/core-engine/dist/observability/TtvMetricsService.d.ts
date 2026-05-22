/**
 * T.5.d: TtvMetricsService — Time-to-Value telemetry.
 *
 * Emits the Prometheus/OTEL metrics that let the platform team measure
 * onboarding effectiveness — time-to-first-task, time-to-first-WOW,
 * organic-dominance trajectory, calibration distribution, action-proposal
 * state transitions, and seed suppression events.
 *
 * Follows the established DocGeneratorMetrics OTEL pattern in this repo:
 *   - dynamic require of @opentelemetry/api; no-op fallback when absent
 *   - histograms for time-to-X observations
 *   - counters for state transitions
 *   - one record() method per metric so call sites are self-documenting
 *
 * Metric inventory:
 *   tenant_ttv_first_task_seconds              histogram, labels: seed_cohort
 *   tenant_ttv_first_warm_recall_seconds       histogram, labels: seed_cohort
 *   tenant_ttv_first_organic_memory_seconds    histogram, labels: seed_cohort
 *   tenant_ttv_first_arm_learned_seconds       histogram, labels: seed_cohort
 *   tenant_ttv_first_wow_seconds               histogram, labels: seed_cohort, kind
 *   tenant_ttv_organic_dominance_seconds       histogram, labels: seed_cohort
 *   tenant_ttv_first_real_action_seconds       histogram, labels: action_class
 *   tenant_ttv_calibration_score               histogram, no labels (per tenant via aggregation)
 *   tenant_ttv_calibration_vector              histogram, labels: action_class
 *   tenant_ttv_bootstrap_step_seconds          histogram, labels: step, status
 *   tenant_seed_suppressed_total               counter,   labels: seed_id
 *   tenant_action_proposal_state_total         counter,   labels: action_class, state
 *   platform_onboarding_throughput_total       counter,   labels: template, outcome
 *   platform_calibration_distribution          histogram, no labels
 *
 * Per ttv.md §SLOs: cardinality is bounded — labels are template/action_class/
 * step/state from closed enums (no tenant_id label by design; per-tenant
 * series would blow Prometheus cardinality at v1 scale).
 */
interface OtelCounter {
    add(value: number, attrs?: Record<string, string | number>): void;
}
interface OtelHistogram {
    record(value: number, attrs?: Record<string, string | number>): void;
}
interface OtelMeter {
    createCounter(name: string, opts?: {
        description?: string;
    }): OtelCounter;
    createHistogram(name: string, opts?: {
        description?: string;
        unit?: string;
    }): OtelHistogram;
}
export type SeedCohort = 'seeded' | 'control' | 'exempt';
export type BootstrapStepStatus = 'ok' | 'skipped' | 'failed';
export type TenantOutcome = 'ready' | 'failed' | 'abandoned' | 'active';
export type ProposalStateTransition = 'pending' | 'promoted' | 'rejected' | 'expired' | 'executed_shadow' | 'executed_live';
export interface FirstTaskParams {
    readonly tenantId: string;
    readonly seedCohort: SeedCohort;
    readonly elapsedSeconds: number;
}
export interface FirstWowParams {
    readonly tenantId: string;
    readonly seedCohort: SeedCohort;
    readonly kind: 'thumbs_up' | 'task_completed_within_30m';
    readonly elapsedSeconds: number;
}
export interface FirstRealActionParams {
    readonly tenantId: string;
    readonly actionClass: string;
    readonly elapsedSeconds: number;
}
export interface CalibrationScoreParams {
    readonly tenantId: string;
    readonly score: number;
    readonly perClass?: Readonly<Record<string, number>>;
}
export interface BootstrapStepParams {
    readonly tenantId: string;
    readonly step: string;
    readonly status: BootstrapStepStatus;
    readonly durationSeconds: number;
}
export interface SeedSuppressedParams {
    readonly tenantId: string;
    readonly seedId: string;
}
export interface ProposalStateParams {
    readonly tenantId: string;
    readonly actionClass: string;
    readonly state: ProposalStateTransition;
}
export interface OnboardingThroughputParams {
    readonly templateSlug: string;
    readonly outcome: TenantOutcome;
}
export declare class TtvMetricsService {
    private readonly firstTaskSeconds;
    private readonly firstWarmRecallSeconds;
    private readonly firstOrganicMemorySeconds;
    private readonly firstArmLearnedSeconds;
    private readonly firstWowSeconds;
    private readonly organicDominanceSeconds;
    private readonly firstRealActionSeconds;
    private readonly calibrationScore;
    private readonly calibrationVector;
    private readonly bootstrapStepSeconds;
    private readonly platformCalibrationDistribution;
    private readonly seedSuppressedTotal;
    private readonly proposalStateTotal;
    private readonly onboardingThroughputTotal;
    constructor(meter?: OtelMeter | undefined);
    recordFirstTask(p: FirstTaskParams): void;
    recordFirstWarmRecall(p: FirstTaskParams): void;
    recordFirstOrganicMemory(p: FirstTaskParams): void;
    recordFirstArmLearned(p: FirstTaskParams): void;
    recordFirstWow(p: FirstWowParams): void;
    recordOrganicDominance(p: FirstTaskParams): void;
    recordFirstRealAction(p: FirstRealActionParams): void;
    /**
     * Record the per-tenant calibration sample. Emits the global score AND
     * (if provided) each per-action-class score. Both feed the platform
     * dashboards and the action trust ladder's audit trail.
     */
    recordCalibrationSample(p: CalibrationScoreParams): void;
    recordBootstrapStep(p: BootstrapStepParams): void;
    incrementSeedSuppressed(p: SeedSuppressedParams): void;
    incrementProposalStateTransition(p: ProposalStateParams): void;
    incrementOnboardingThroughput(p: OnboardingThroughputParams): void;
}
export {};
//# sourceMappingURL=TtvMetricsService.d.ts.map