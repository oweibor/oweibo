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

interface OtelCounter   { add(value: number, attrs?: Record<string, string | number>): void }
interface OtelHistogram { record(value: number, attrs?: Record<string, string | number>): void }
interface OtelMeter {
  createCounter(name: string, opts?: { description?: string }): OtelCounter;
  createHistogram(name: string, opts?: { description?: string; unit?: string }): OtelHistogram;
}

const noopCounter: OtelCounter = { add: () => undefined };
const noopHistogram: OtelHistogram = { record: () => undefined };

function tryGetMeter(): OtelMeter | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const otel = require('@opentelemetry/api') as { metrics: { getMeter(name: string): OtelMeter } };
    return otel.metrics.getMeter('oweibo-ttv');
  } catch {
    return undefined;
  }
}

// ── Public types ─────────────────────────────────────────────────────────

export type SeedCohort = 'seeded' | 'control' | 'exempt';
export type BootstrapStepStatus = 'ok' | 'skipped' | 'failed';
export type TenantOutcome = 'ready' | 'failed' | 'abandoned' | 'active';
export type ProposalStateTransition =
  | 'pending'
  | 'promoted'
  | 'rejected'
  | 'expired'
  | 'executed_shadow'
  | 'executed_live';

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

// ── Service ──────────────────────────────────────────────────────────────

export class TtvMetricsService {
  // Histograms (time-to-X and distribution metrics)
  private readonly firstTaskSeconds:           OtelHistogram;
  private readonly firstWarmRecallSeconds:     OtelHistogram;
  private readonly firstOrganicMemorySeconds:  OtelHistogram;
  private readonly firstArmLearnedSeconds:     OtelHistogram;
  private readonly firstWowSeconds:            OtelHistogram;
  private readonly organicDominanceSeconds:    OtelHistogram;
  private readonly firstRealActionSeconds:     OtelHistogram;
  private readonly calibrationScore:           OtelHistogram;
  private readonly calibrationVector:          OtelHistogram;
  private readonly bootstrapStepSeconds:       OtelHistogram;
  private readonly platformCalibrationDistribution: OtelHistogram;
  // Counters (transitions and event counts)
  private readonly seedSuppressedTotal:        OtelCounter;
  private readonly proposalStateTotal:         OtelCounter;
  private readonly onboardingThroughputTotal:  OtelCounter;

  constructor(meter: OtelMeter | undefined = tryGetMeter()) {
    this.firstTaskSeconds          = meter?.createHistogram('tenant_ttv_first_task_seconds',          { description: 'Time from tenant.created to first completed task',                unit: 's' }) ?? noopHistogram;
    this.firstWarmRecallSeconds    = meter?.createHistogram('tenant_ttv_first_warm_recall_seconds',   { description: 'Time to first non-empty MemoryWarmer result',                     unit: 's' }) ?? noopHistogram;
    this.firstOrganicMemorySeconds = meter?.createHistogram('tenant_ttv_first_organic_memory_seconds',{ description: 'Time to first non-seed memory in the tenant collection',          unit: 's' }) ?? noopHistogram;
    this.firstArmLearnedSeconds    = meter?.createHistogram('tenant_ttv_first_arm_learned_seconds',   { description: 'Time to first per-slot bandit arm with >1 observation',           unit: 's' }) ?? noopHistogram;
    this.firstWowSeconds           = meter?.createHistogram('tenant_ttv_first_wow_seconds',           { description: 'Time from tenant.created to first WOW event',                     unit: 's' }) ?? noopHistogram;
    this.organicDominanceSeconds   = meter?.createHistogram('tenant_ttv_organic_dominance_seconds',   { description: 'Time to first MemoryWarmer result that is >=50% organic',         unit: 's' }) ?? noopHistogram;
    this.firstRealActionSeconds    = meter?.createHistogram('tenant_ttv_first_real_action_seconds',   { description: 'Time to first action of a class that cleared the T.-1 ladder',    unit: 's' }) ?? noopHistogram;
    this.calibrationScore          = meter?.createHistogram('tenant_ttv_calibration_score',           { description: 'Current global readiness score, sampled periodically' })                       ?? noopHistogram;
    this.calibrationVector         = meter?.createHistogram('tenant_ttv_calibration_vector',          { description: 'Current per-action-class readiness score' })                                   ?? noopHistogram;
    this.bootstrapStepSeconds      = meter?.createHistogram('tenant_ttv_bootstrap_step_seconds',      { description: 'Bootstrap step duration',                                        unit: 's' }) ?? noopHistogram;
    this.platformCalibrationDistribution = meter?.createHistogram('platform_calibration_distribution',{ description: 'Per-tenant calibration scores aggregated across all active tenants' })       ?? noopHistogram;

    this.seedSuppressedTotal       = meter?.createCounter('tenant_seed_suppressed_total',             { description: 'Counter incremented when feedback loop suppresses a seed' })                  ?? noopCounter;
    this.proposalStateTotal        = meter?.createCounter('tenant_action_proposal_state_total',       { description: 'Counter on action_proposals state transitions' })                              ?? noopCounter;
    this.onboardingThroughputTotal = meter?.createCounter('platform_onboarding_throughput_total',     { description: 'New tenants per template per outcome' })                                       ?? noopCounter;
  }

  // ── Time-to-X recorders ────────────────────────────────────────────────

  recordFirstTask(p: FirstTaskParams): void {
    this.firstTaskSeconds.record(p.elapsedSeconds, { seed_cohort: p.seedCohort });
  }

  recordFirstWarmRecall(p: FirstTaskParams): void {
    this.firstWarmRecallSeconds.record(p.elapsedSeconds, { seed_cohort: p.seedCohort });
  }

  recordFirstOrganicMemory(p: FirstTaskParams): void {
    this.firstOrganicMemorySeconds.record(p.elapsedSeconds, { seed_cohort: p.seedCohort });
  }

  recordFirstArmLearned(p: FirstTaskParams): void {
    this.firstArmLearnedSeconds.record(p.elapsedSeconds, { seed_cohort: p.seedCohort });
  }

  recordFirstWow(p: FirstWowParams): void {
    this.firstWowSeconds.record(p.elapsedSeconds, { seed_cohort: p.seedCohort, kind: p.kind });
  }

  recordOrganicDominance(p: FirstTaskParams): void {
    this.organicDominanceSeconds.record(p.elapsedSeconds, { seed_cohort: p.seedCohort });
  }

  recordFirstRealAction(p: FirstRealActionParams): void {
    this.firstRealActionSeconds.record(p.elapsedSeconds, { action_class: p.actionClass });
  }

  // ── Calibration recorders ──────────────────────────────────────────────

  /**
   * Record the per-tenant calibration sample. Emits the global score AND
   * (if provided) each per-action-class score. Both feed the platform
   * dashboards and the action trust ladder's audit trail.
   */
  recordCalibrationSample(p: CalibrationScoreParams): void {
    this.calibrationScore.record(p.score);
    this.platformCalibrationDistribution.record(p.score);
    if (p.perClass) {
      for (const [cls, val] of Object.entries(p.perClass)) {
        this.calibrationVector.record(val, { action_class: cls });
      }
    }
  }

  // ── Bootstrap step ─────────────────────────────────────────────────────

  recordBootstrapStep(p: BootstrapStepParams): void {
    this.bootstrapStepSeconds.record(p.durationSeconds, { step: p.step, status: p.status });
  }

  // ── Counters ───────────────────────────────────────────────────────────

  incrementSeedSuppressed(p: SeedSuppressedParams): void {
    this.seedSuppressedTotal.add(1, { seed_id: p.seedId });
  }

  incrementProposalStateTransition(p: ProposalStateParams): void {
    this.proposalStateTotal.add(1, { action_class: p.actionClass, state: p.state });
  }

  incrementOnboardingThroughput(p: OnboardingThroughputParams): void {
    this.onboardingThroughputTotal.add(1, { template: p.templateSlug, outcome: p.outcome });
  }
}
