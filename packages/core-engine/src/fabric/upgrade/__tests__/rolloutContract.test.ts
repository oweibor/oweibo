/**
 * K.9 / ADR-004 §7 — the upgrade rollout pure rules (armed at K.9).
 *
 * Blue/green (in-flight work never crosses versions), canary-by-cohort, and
 * rollback re-tagging. Pure predicates; the live battery exercises the service.
 */
import {
  effectiveJobVersion,
  isLegalRolloutTransition,
  jobsToRetagOnRollback,
  tenantInCanary,
  workerCanClaim,
  type ConnectorDeployment,
} from '../rolloutContract';

const dep = (over: Partial<ConnectorDeployment> = {}): ConnectorDeployment => ({
  tenantId: 't1',
  connectorId: 'slack',
  activeVersion: '1.0.0',
  state: 'stable',
  tenantCohort: 'stable-v0',
  ...over,
});

describe('ADR-004 §3.7 — blue/green: in-flight work never crosses versions', () => {
  it('a worker claims only jobs tagged at its own version', () => {
    expect(workerCanClaim('1.0.0', '1.0.0')).toBe(true);
    expect(workerCanClaim('2.0.0', '1.0.0')).toBe(false);
    expect(workerCanClaim('1.0.0', '2.0.0')).toBe(false);
  });

  it('legacy untagged jobs (pre-column) are claimable by any worker', () => {
    // The additive migration must not strand jobs queued before version tagging.
    expect(workerCanClaim(null, '1.0.0')).toBe(true);
    expect(workerCanClaim(undefined, '2.0.0')).toBe(true);
  });
});

describe('ADR-004 §3.7 — canary-by-cohort', () => {
  it('a cohort tenant mints jobs at the target version; others stay on active', () => {
    const canaried = dep({ state: 'canary', targetVersion: '2.0.0', canaryCohort: 'canary-a', tenantCohort: 'canary-a' });
    expect(effectiveJobVersion(canaried)).toBe('2.0.0');

    const outside = dep({ state: 'canary', targetVersion: '2.0.0', canaryCohort: 'canary-a', tenantCohort: 'stable-v0' });
    expect(effectiveJobVersion(outside)).toBe('1.0.0'); // untouched until promotion
  });

  it('a stable deployment always mints at the active version', () => {
    expect(effectiveJobVersion(dep())).toBe('1.0.0');
  });

  it('a rolling-back deployment mints at the active (prior) version', () => {
    expect(effectiveJobVersion(dep({ state: 'rolling_back', targetVersion: '2.0.0' }))).toBe('1.0.0');
  });

  it('tenantInCanary matches on cohort', () => {
    expect(tenantInCanary({ tenantCohort: 'canary-a' }, 'canary-a')).toBe(true);
    expect(tenantInCanary({ tenantCohort: 'stable-v0' }, 'canary-a')).toBe(false);
  });
});

describe('ADR-004 §3.7 — rollback re-tags queued jobs only', () => {
  const jobs = [
    { jobId: 'j1', state: 'queued', connectorVersion: '2.0.0' },   // re-tag
    { jobId: 'j2', state: 'queued', connectorVersion: '2.0.0' },   // re-tag
    { jobId: 'j3', state: 'leased', connectorVersion: '2.0.0' },   // LEAVE — finishes under 2.0.0
    { jobId: 'j4', state: 'queued', connectorVersion: '1.0.0' },   // already prior — untouched
    { jobId: 'j5', state: 'succeeded', connectorVersion: '2.0.0' },// terminal — untouched
  ];

  it('re-tags only queued jobs at the target version', () => {
    expect(jobsToRetagOnRollback(jobs, '2.0.0', '1.0.0')).toEqual(['j1', 'j2']);
  });

  it('a leased job is NOT re-tagged — blue/green never yanks running work', () => {
    const result = jobsToRetagOnRollback(jobs, '2.0.0', '1.0.0');
    expect(result).not.toContain('j3');
  });

  it('a no-op rollback (target == prior) re-tags nothing', () => {
    expect(jobsToRetagOnRollback(jobs, '1.0.0', '1.0.0')).toEqual([]);
  });
});

describe('ADR-004 §3.7 — rollout transition guard', () => {
  it('permits the legal moves only', () => {
    expect(isLegalRolloutTransition('stable', 'canary')).toBe(true);
    expect(isLegalRolloutTransition('canary', 'stable')).toBe(true);       // promote
    expect(isLegalRolloutTransition('canary', 'rolling_back')).toBe(true); // rollback
    expect(isLegalRolloutTransition('rolling_back', 'stable')).toBe(true);
  });

  it('rejects illegal moves (no canary→canary re-target, no stable→rolling_back)', () => {
    expect(isLegalRolloutTransition('stable', 'rolling_back')).toBe(false);
    expect(isLegalRolloutTransition('canary', 'canary')).toBe(false);
    expect(isLegalRolloutTransition('rolling_back', 'canary')).toBe(false);
  });
});
