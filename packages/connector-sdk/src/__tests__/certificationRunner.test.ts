/**
 * D.4 — certificationRunner tests.
 */
import { declareConnector } from '../declareConnector.js';
import { runCertificationSuite } from '../certificationRunner.js';
import type { DomainCertificationBattery } from '../domainBattery.js';

const baseSpec = {
  connectorId: 'demo',
  displayName: 'Demo',
  category: 'custom' as const,
  description: 'demo',
  catalogVersion: '1.0.0',
  credentialSchema: { type: 'object' },
  capabilities: [
    {
      capabilityId: 'do-thing',
      summary: 'Do a thing',
      actionClass: 'write.local.scratch',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      invoke: async () => ({ status: 'ok' as const }),
      sandbox: { mode: 'mock' as const },
    },
  ],
  certificationTarget: 'community' as const,
};

describe('runCertificationSuite — experimental tier', () => {
  it('only runs schema_validation + tier_alignment', async () => {
    const bundle = declareConnector({ ...baseSpec, certificationTarget: 'experimental' });
    const report = await runCertificationSuite({ bundle, tier: 'experimental' });
    expect(report.passed).toBe(true);
    expect(report.steps.map((s) => s.step)).toEqual(['schema_validation', 'tier_alignment']);
  });

  it('fails when bundle.certificationTarget != runner tier', async () => {
    const bundle = declareConnector({ ...baseSpec, certificationTarget: 'experimental' });
    const report = await runCertificationSuite({ bundle, tier: 'community' });
    expect(report.passed).toBe(false);
    expect(report.steps.find((s) => s.step === 'tier_alignment')?.passed).toBe(false);
  });
});

describe('runCertificationSuite — community tier', () => {
  it('runs sandbox + wiring steps and passes a clean bundle', async () => {
    const bundle = declareConnector(baseSpec);
    const report = await runCertificationSuite({ bundle, tier: 'community' });
    expect(report.passed).toBe(true);
    const steps = report.steps.map((s) => s.step);
    expect(steps).toContain('sandbox_round_trip');
    expect(steps).toContain('inspector_verifier_wiring');
  });

  it('lets a custom sandboxInvoker surface invocation errors', async () => {
    const bundle = declareConnector(baseSpec);
    const report = await runCertificationSuite({
      bundle,
      tier: 'community',
      sandboxInvoker: async () => {
        throw new Error('sandbox blew up');
      },
    });
    expect(report.passed).toBe(false);
    const sb = report.steps.find((s) => s.step === 'sandbox_round_trip');
    expect(sb?.passed).toBe(false);
    expect(sb?.violations[0]).toMatch(/sandbox blew up/);
  });
});

describe('runCertificationSuite — verified tier', () => {
  it('requires at least one platform reviewer', async () => {
    const bundle = declareConnector({ ...baseSpec, certificationTarget: 'verified' });
    const noReviewers = await runCertificationSuite({ bundle, tier: 'verified' });
    expect(noReviewers.passed).toBe(false);
    expect(noReviewers.steps.find((s) => s.step === 'platform_review')?.passed).toBe(false);

    const withReviewers = await runCertificationSuite({
      bundle,
      tier: 'verified',
      platformReviewers: ['platform-engineer-1'],
    });
    expect(withReviewers.passed).toBe(true);
  });
});

describe('runCertificationSuite — enterprise tier', () => {
  const fintechBattery: DomainCertificationBattery = {
    domainSlug: 'fintech',
    assertions: [
      {
        id: 'output-not-empty',
        description: 'sandbox invocation returns a non-null output',
        run: async (_bundle, harness) => {
          const r = await harness.invokeSandboxed('do-thing', {});
          harness.assert(r.output !== null && r.output !== undefined, 'output was nullish');
        },
      },
    ],
  };

  it('requires named maintainer + every certifiedFor battery to pass', async () => {
    const bundle = declareConnector({
      ...baseSpec,
      certificationTarget: 'enterprise',
      certifiedFor: ['fintech'],
    });
    const missing = await runCertificationSuite({
      bundle,
      tier: 'enterprise',
      platformReviewers: ['p1'],
    });
    expect(missing.passed).toBe(false);
    // Both maintainer + domain_batteries fail.
    expect(missing.steps.find((s) => s.step === 'named_maintainer')?.passed).toBe(false);
    expect(missing.steps.find((s) => s.step === 'domain_batteries')?.passed).toBe(false);

    const ok = await runCertificationSuite({
      bundle,
      tier: 'enterprise',
      platformReviewers: ['p1'],
      maintainer: { name: 'sre-team@oweibo', slaMinutes: 60 },
      batteries: { fintech: fintechBattery },
    });
    expect(ok.passed).toBe(true);
  });

  it('fails enterprise when a certifiedFor domain has no battery', async () => {
    const bundle = declareConnector({
      ...baseSpec,
      certificationTarget: 'enterprise',
      certifiedFor: ['fintech'],
    });
    const r = await runCertificationSuite({
      bundle,
      tier: 'enterprise',
      platformReviewers: ['p1'],
      maintainer: { name: 'm', slaMinutes: 60 },
      batteries: {},
    });
    expect(r.passed).toBe(false);
    expect(r.steps.find((s) => s.step === 'domain_batteries')?.violations[0]).toMatch(
      /no certification battery/,
    );
  });
});

describe('runCertificationSuite — testSuiteHash', () => {
  it('produces a deterministic hash for the same bundle + tier + step pass-pattern', async () => {
    const bundle = declareConnector(baseSpec);
    const a = await runCertificationSuite({ bundle, tier: 'community' });
    const b = await runCertificationSuite({ bundle, tier: 'community' });
    expect(a.testSuiteHash).toBe(b.testSuiteHash);
  });

  it('changes when the tier changes', async () => {
    const exp = declareConnector({ ...baseSpec, certificationTarget: 'experimental' });
    const com = declareConnector(baseSpec);
    const a = await runCertificationSuite({ bundle: exp, tier: 'experimental' });
    const b = await runCertificationSuite({ bundle: com, tier: 'community' });
    expect(a.testSuiteHash).not.toBe(b.testSuiteHash);
  });
});
