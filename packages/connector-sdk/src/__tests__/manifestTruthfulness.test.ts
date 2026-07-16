/**
 * ADR-012 conformance: manifest truthfulness (INV-15).
 *
 * Interim executable conformance at ADR-012 ratification. The full certification
 * harness that drives real port probes into `demonstrated` arrives at K.1
 * (exit gate: a mock that lies in its manifest fails certification).
 */
import {
  checkManifestTruthfulness,
  type SupportMap,
} from '../contract/manifestTruthfulness';

describe('INV-15 — manifest truthfulness (checkManifestTruthfulness)', () => {
  it('passes when every declared capability is demonstrated', () => {
    const declared: SupportMap = { changeFeed: true, content: true, acl: true };
    const demonstrated: SupportMap = { changeFeed: true, content: true, acl: true };
    const report = checkManifestTruthfulness(declared, demonstrated);
    expect(report.ok).toBe(true);
    expect(report.violations).toHaveLength(0);
  });

  it('fails a manifest that declares webhooks but implements none (the K.1 exit-gate case)', () => {
    const declared: SupportMap = { content: true, webhooks: true };
    const demonstrated: SupportMap = { content: true }; // no webhooks probe passed
    const report = checkManifestTruthfulness(declared, demonstrated);
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => v.flag)).toEqual(['webhooks']);
  });

  it('reports every declared-but-undemonstrated flag, not just the first', () => {
    const declared: SupportMap = { deltaSync: true, groups: true, activitySignals: true };
    const demonstrated: SupportMap = {};
    const report = checkManifestTruthfulness(declared, demonstrated);
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => v.flag).sort()).toEqual(
      ['activitySignals', 'deltaSync', 'groups'],
    );
  });

  it('does NOT fail for demonstrated-but-undeclared — honest omission is allowed', () => {
    const declared: SupportMap = { content: true };
    const demonstrated: SupportMap = { content: true, activity: true };
    const report = checkManifestTruthfulness(declared, demonstrated);
    expect(report.ok).toBe(true);
    expect(report.violations).toHaveLength(0);
    expect(report.undeclared).toEqual(['activity']);
  });

  it('a flag declared false is never a violation regardless of demonstration', () => {
    const declared: SupportMap = { webhooks: false };
    const demonstrated: SupportMap = {};
    const report = checkManifestTruthfulness(declared, demonstrated);
    expect(report.ok).toBe(true);
  });

  it('empty manifest is trivially truthful', () => {
    const report = checkManifestTruthfulness({}, {});
    expect(report.ok).toBe(true);
    expect(report.violations).toHaveLength(0);
    expect(report.undeclared).toHaveLength(0);
  });
});
