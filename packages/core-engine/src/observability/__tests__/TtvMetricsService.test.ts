/**
 * T.5.d — TtvMetricsService tests. Drives a fake OTEL meter and verifies
 * each recorder writes to the correct metric with the correct labels.
 */
import { TtvMetricsService } from '../TtvMetricsService.js';

interface Recorded { metric: string; value: number; attrs?: Record<string, string | number> }

function fakeMeter(): { meter: any; records: Recorded[] } {
  const records: Recorded[] = [];
  const histogram = (name: string) => ({
    record: (value: number, attrs?: Record<string, string | number>) => {
      records.push({ metric: name, value, attrs });
    },
  });
  const counter = (name: string) => ({
    add: (value: number, attrs?: Record<string, string | number>) => {
      records.push({ metric: name, value, attrs });
    },
  });
  const meter = {
    createHistogram: (name: string) => histogram(name),
    createCounter: (name: string) => counter(name),
  };
  return { meter, records };
}

describe('TtvMetricsService — time-to-X histograms', () => {
  it('recordFirstTask writes to tenant_ttv_first_task_seconds with seed_cohort', () => {
    const { meter, records } = fakeMeter();
    const svc = new TtvMetricsService(meter);
    svc.recordFirstTask({ tenantId: 't1', seedCohort: 'seeded', elapsedSeconds: 42 });
    const rec = records.find((r) => r.metric === 'tenant_ttv_first_task_seconds');
    expect(rec).toBeDefined();
    expect(rec?.value).toBe(42);
    expect(rec?.attrs).toEqual({ seed_cohort: 'seeded' });
  });

  it('recordFirstWarmRecall writes the warm-recall histogram', () => {
    const { meter, records } = fakeMeter();
    new TtvMetricsService(meter).recordFirstWarmRecall({ tenantId: 't', seedCohort: 'control', elapsedSeconds: 7 });
    expect(records.find((r) => r.metric === 'tenant_ttv_first_warm_recall_seconds')?.value).toBe(7);
  });

  it('recordFirstOrganicMemory + FirstArmLearned + OrganicDominance all carry seed_cohort', () => {
    const { meter, records } = fakeMeter();
    const svc = new TtvMetricsService(meter);
    svc.recordFirstOrganicMemory({ tenantId: 't', seedCohort: 'seeded', elapsedSeconds: 1 });
    svc.recordFirstArmLearned({ tenantId: 't', seedCohort: 'seeded', elapsedSeconds: 2 });
    svc.recordOrganicDominance({ tenantId: 't', seedCohort: 'seeded', elapsedSeconds: 3 });
    for (const name of [
      'tenant_ttv_first_organic_memory_seconds',
      'tenant_ttv_first_arm_learned_seconds',
      'tenant_ttv_organic_dominance_seconds',
    ]) {
      expect(records.find((r) => r.metric === name)?.attrs?.seed_cohort).toBe('seeded');
    }
  });

  it('recordFirstWow carries seed_cohort and kind', () => {
    const { meter, records } = fakeMeter();
    new TtvMetricsService(meter).recordFirstWow({
      tenantId: 't', seedCohort: 'seeded', kind: 'thumbs_up', elapsedSeconds: 600,
    });
    const rec = records.find((r) => r.metric === 'tenant_ttv_first_wow_seconds');
    expect(rec?.attrs).toEqual({ seed_cohort: 'seeded', kind: 'thumbs_up' });
    expect(rec?.value).toBe(600);
  });

  it('recordFirstRealAction labels by action_class', () => {
    const { meter, records } = fakeMeter();
    new TtvMetricsService(meter).recordFirstRealAction({
      tenantId: 't', actionClass: 'write.external_api.nonprod', elapsedSeconds: 90,
    });
    const rec = records.find((r) => r.metric === 'tenant_ttv_first_real_action_seconds');
    expect(rec?.attrs).toEqual({ action_class: 'write.external_api.nonprod' });
  });
});

describe('TtvMetricsService — calibration sampling', () => {
  it('records the global score AND the platform_calibration_distribution', () => {
    const { meter, records } = fakeMeter();
    new TtvMetricsService(meter).recordCalibrationSample({ tenantId: 't', score: 0.45 });
    expect(records.find((r) => r.metric === 'tenant_ttv_calibration_score')?.value).toBe(0.45);
    expect(records.find((r) => r.metric === 'platform_calibration_distribution')?.value).toBe(0.45);
  });

  it('records each per-class score with the action_class label when perClass is provided', () => {
    const { meter, records } = fakeMeter();
    new TtvMetricsService(meter).recordCalibrationSample({
      tenantId: 't', score: 0.7,
      perClass: { 'write.local.scratch': 0.9, 'financial.payment': 0.1 },
    });
    const vectorRecs = records.filter((r) => r.metric === 'tenant_ttv_calibration_vector');
    expect(vectorRecs).toHaveLength(2);
    expect(vectorRecs.find((r) => r.attrs?.action_class === 'write.local.scratch')?.value).toBe(0.9);
    expect(vectorRecs.find((r) => r.attrs?.action_class === 'financial.payment')?.value).toBe(0.1);
  });

  it('omits per-class records when perClass is absent', () => {
    const { meter, records } = fakeMeter();
    new TtvMetricsService(meter).recordCalibrationSample({ tenantId: 't', score: 0.5 });
    expect(records.find((r) => r.metric === 'tenant_ttv_calibration_vector')).toBeUndefined();
  });
});

describe('TtvMetricsService — bootstrap steps', () => {
  it('records duration with step + status labels', () => {
    const { meter, records } = fakeMeter();
    new TtvMetricsService(meter).recordBootstrapStep({
      tenantId: 't', step: 'seed_memories', status: 'ok', durationSeconds: 12.3,
    });
    const rec = records.find((r) => r.metric === 'tenant_ttv_bootstrap_step_seconds');
    expect(rec?.attrs).toEqual({ step: 'seed_memories', status: 'ok' });
    expect(rec?.value).toBeCloseTo(12.3, 5);
  });
});

describe('TtvMetricsService — counters', () => {
  it('increments seed_suppressed_total with seed_id label', () => {
    const { meter, records } = fakeMeter();
    new TtvMetricsService(meter).incrementSeedSuppressed({ tenantId: 't', seedId: 's-1' });
    const rec = records.find((r) => r.metric === 'tenant_seed_suppressed_total');
    expect(rec?.value).toBe(1);
    expect(rec?.attrs).toEqual({ seed_id: 's-1' });
  });

  it('increments proposal_state_total with action_class + state labels', () => {
    const { meter, records } = fakeMeter();
    new TtvMetricsService(meter).incrementProposalStateTransition({
      tenantId: 't', actionClass: 'write.external_api.prod', state: 'promoted',
    });
    const rec = records.find((r) => r.metric === 'tenant_action_proposal_state_total');
    expect(rec?.attrs).toEqual({ action_class: 'write.external_api.prod', state: 'promoted' });
  });

  it('increments platform_onboarding_throughput_total with template + outcome', () => {
    const { meter, records } = fakeMeter();
    new TtvMetricsService(meter).incrementOnboardingThroughput({
      templateSlug: 'nextjs-app', outcome: 'ready',
    });
    const rec = records.find((r) => r.metric === 'platform_onboarding_throughput_total');
    expect(rec?.attrs).toEqual({ template: 'nextjs-app', outcome: 'ready' });
  });
});

describe('TtvMetricsService — graceful degradation', () => {
  it('all recorders are no-ops when OTEL meter is undefined', () => {
    const svc = new TtvMetricsService(undefined);
    // None of these should throw.
    svc.recordFirstTask({ tenantId: 't', seedCohort: 'seeded', elapsedSeconds: 1 });
    svc.recordCalibrationSample({ tenantId: 't', score: 0.5 });
    svc.recordBootstrapStep({ tenantId: 't', step: 's', status: 'ok', durationSeconds: 1 });
    svc.incrementSeedSuppressed({ tenantId: 't', seedId: 'x' });
    svc.incrementProposalStateTransition({ tenantId: 't', actionClass: 'a', state: 'pending' });
    svc.incrementOnboardingThroughput({ templateSlug: 't', outcome: 'ready' });
    expect(true).toBe(true);
  });
});
