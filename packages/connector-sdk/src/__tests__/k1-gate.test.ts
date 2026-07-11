/**
 * K.1 exit gate (ADR-012 §7, roadmap K.1):
 *   (a) a compact mock connector passes full certification
 *   (b) a mock that LIES in its manifest (declares webhooks, implements
 *       none) FAILS certification — INV-15
 *   (c) each implemented port passes its per-port contract test
 *   (+) pre-K.1 (D.4) bundles certify exactly as before — the new steps
 *       are presence-gated
 *
 * (d) — a connector importing anything but the SDK fails check-boundaries
 * — is enforced by the repo-level dependency-cruiser rules (ADR-000), not
 * testable from inside this package.
 */
import { declareConnector, type DeclareConnectorSpec } from '../declareConnector.js';
import { runCertificationSuite } from '../certificationRunner.js';
import { runPortContractTests } from '../portContracts.js';
import { MockSourceAdapter, makeMockContext } from '../testing/mockSource.js';
import { isSdkVersionCompatible, SDK_VERSION } from '../version.js';

/** A populated mock source shared by the gate specs. */
function seededSource(): MockSourceAdapter {
  const source = new MockSourceAdapter({
    documents: [
      { ref: 'doc-1', fields: { title: 'Q3 plan', body: 'alpha' }, revision: 'r1' },
      { ref: 'doc-2', fields: { title: 'Runbook', body: 'beta' }, revision: 'r1' },
      { ref: 'doc-3', fields: { title: 'Postmortem', body: 'gamma' }, revision: 'r2' },
    ],
    acls: {
      'doc-1': { aclVersion: 'a1', principals: [{ principal: 'u-1', kind: 'user', access: 'read' }] },
      'doc-2': { aclVersion: 'a1', principals: [{ principal: 'g-eng', kind: 'group', access: 'read' }] },
      'doc-3': { aclVersion: 'a2', principals: [{ principal: 'u-2', kind: 'user', access: 'owner' }] },
    },
    principals: [
      { id: 'u-1', email: 'ada@example.test', status: 'active' },
      { id: 'u-2', email: 'lin@example.test', status: 'active' },
    ],
    groups: [
      { id: 'g-eng', displayName: 'Engineering', memberPrincipals: ['u-1'], memberGroups: ['g-core'] },
      { id: 'g-core', displayName: 'Core', memberPrincipals: ['u-2'], memberGroups: [] },
    ],
    activity: [
      { ref: 'doc-1', kind: 'view', principal: 'u-1', occurredAt: '2026-07-10T12:00:00Z' },
      { ref: 'doc-3', kind: 'edit', principal: 'u-2', occurredAt: '2026-07-10T13:00:00Z' },
    ],
  });
  return source;
}

/**
 * The exit-gate mock connector: full Glean face + one action capability +
 * webhook lifecycle hooks. This is the "~300 lines including the source"
 * connector the budget contemplates — the authored surface below is thin
 * precisely because the ports are interfaces over MockSourceAdapter.
 */
function mockConnectorSpec(source: MockSourceAdapter): DeclareConnectorSpec {
  return {
    connectorId: 'mock-source',
    displayName: 'Mock Source',
    category: 'custom',
    description: 'K.1 exit-gate fixture connector',
    catalogVersion: '1.0.0',
    credentialSchema: { type: 'object', properties: { token: { type: 'string' } } },
    certificationTarget: 'community',
    sdkVersion: SDK_VERSION,
    enablementTier: 1,
    heartbeatSeconds: 300,
    dataResidency: 'us-east-1',
    supports: {
      changeFeed: true,
      content: true,
      acl: true,
      principals: true,
      groups: true,
      activity: true,
      activitySignals: true,
      actions: true,
      deltaSync: true,
      webhooks: true,
    },
    ports: {
      changeFeed: source.changeFeedPort(),
      content: source.contentPort(),
      acl: source.aclPort(),
      principals: source.principalsPort(),
      activity: source.activityPort(),
    },
    freshnessClasses: { title: 'daily', body: 'daily' },
    registerWebhook: source.registerWebhookHook(),
    unregisterWebhook: source.unregisterWebhookHook(),
    validateConnection: async () => ({ ok: true, effectiveSupports: { changeFeed: true, content: true } }),
    capabilities: [
      {
        capabilityId: 'annotate-document',
        summary: 'Attach an annotation to a document',
        actionClass: 'comm.internal_note',
        inputSchema: { type: 'object', properties: { ref: { type: 'string' } } },
        outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        sandbox: { mode: 'mock' },
        invoke: async () => ({ status: 'ok', output: { ok: true } }),
      },
    ],
  };
}

describe('K.1 exit gate', () => {
  it('(a) the mock connector passes full certification', async () => {
    const source = seededSource();
    const bundle = declareConnector(mockConnectorSpec(source));
    const report = await runCertificationSuite({
      bundle,
      tier: 'community',
      portContext: makeMockContext(),
    });

    const byStep = Object.fromEntries(report.steps.map((s) => [s.step, s]));
    expect(byStep['port_contract_tests']?.passed).toBe(true);
    expect(byStep['manifest_truthfulness']?.passed).toBe(true);
    expect(report.passed).toBe(true);
    // The webhook round-trip must have actually happened (and cleaned up).
    expect(source.webhookRegistrations.size).toBe(0);
  });

  it('(b) a manifest that declares webhooks but implements none FAILS certification', async () => {
    const source = seededSource();
    const spec = mockConnectorSpec(source);
    const lying: DeclareConnectorSpec = {
      ...spec,
      // The lie: keep supports.webhooks=true, drop the hooks. Note this
      // constructs fine — declareConnector deliberately does not police
      // honesty; certification does (the whole point of the gate).
    };
    delete (lying as Partial<DeclareConnectorSpec>).registerWebhook;
    delete (lying as Partial<DeclareConnectorSpec>).unregisterWebhook;

    const bundle = declareConnector(lying);
    const report = await runCertificationSuite({
      bundle,
      tier: 'community',
      portContext: makeMockContext(),
    });

    expect(report.passed).toBe(false);
    const truth = report.steps.find((s) => s.step === 'manifest_truthfulness');
    expect(truth?.passed).toBe(false);
    expect(truth?.violations.join('\n')).toMatch(/declares 'webhooks'.*INV-15/);
  });

  it('(b2) declaring deltaSync over a snapshot-only feed fails', async () => {
    const source = seededSource();
    const spec = mockConnectorSpec(source);
    // Replace the feed with a snapshot-only listing (nextCursor: null at
    // the tail) while still declaring deltaSync.
    const snapshotOnly = source.changeFeedPort();
    const bundle = declareConnector({
      ...spec,
      ports: {
        ...spec.ports,
        changeFeed: {
          ...snapshotOnly,
          listChanges: async (ctx, cursor) => {
            const page = await snapshotOnly.listChanges(ctx, cursor);
            // Chop off the resumable tail: pretend the feed just ends.
            return page.items.length === 0 ? { items: [], nextCursor: null } : page;
          },
        },
      },
    });
    const report = await runCertificationSuite({
      bundle,
      tier: 'community',
      portContext: makeMockContext(),
    });
    expect(report.passed).toBe(false);
    const truth = report.steps.find((s) => s.step === 'manifest_truthfulness');
    expect(truth?.violations.join('\n')).toMatch(/declares 'deltaSync'/);
  });

  it('(c) each implemented port passes its contract test and is demonstrated', async () => {
    const source = seededSource();
    const bundle = declareConnector(mockConnectorSpec(source));
    const report = await runPortContractTests(bundle, makeMockContext());

    expect(report.violations).toEqual([]);
    expect(report.demonstrated).toMatchObject({
      changeFeed: true,
      deltaSync: true,
      content: true,
      acl: true,
      principals: true,
      groups: true,
      activity: true,
      activitySignals: true,
      webhooks: true,
    });
    expect(report.exercised).toEqual(
      expect.arrayContaining(['changeFeed', 'deltaSync', 'content', 'acl', 'principals', 'groups', 'activity', 'webhooks']),
    );
  });

  it('(c2) a looping cursor is a contract violation, not a hang', async () => {
    const source = seededSource();
    const spec = mockConnectorSpec(source);
    const bundle = declareConnector({
      ...spec,
      supports: { changeFeed: true },
      ports: {
        changeFeed: {
          apiVersion: 'v1',
          probe: async () => ({ ok: true }),
          // Always returns the same page with the same cursor + items.
          listChanges: async () => ({
            items: [{ ref: 'doc-1', kind: 'updated' as const }],
            nextCursor: 'stuck',
          }),
        },
      },
    });
    const report = await runPortContractTests(bundle, makeMockContext());
    expect(report.violations.join('\n')).toMatch(/cursor.*(repeated|did not progress)/);
    expect(report.demonstrated.changeFeed).not.toBe(true);
  });

  it('pre-K.1 (D.4) bundles skip the new steps entirely', async () => {
    const bundle = declareConnector({
      connectorId: 'legacy-d4',
      displayName: 'Legacy',
      category: 'custom',
      description: 'a pre-K.1 connector',
      catalogVersion: '1.0.0',
      credentialSchema: { type: 'object' },
      certificationTarget: 'community',
      capabilities: [
        {
          capabilityId: 'do-thing',
          summary: 'does a thing',
          actionClass: 'comm.internal_note',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          sandbox: { mode: 'mock' },
          invoke: async () => ({ status: 'ok' }),
        },
      ],
    });
    const report = await runCertificationSuite({ bundle, tier: 'community' });
    expect(report.passed).toBe(true);
    const stepNames = report.steps.map((s) => s.step);
    expect(stepNames).not.toContain('port_contract_tests');
    expect(stepNames).not.toContain('manifest_truthfulness');
  });

  it('complexity gate surfaces a finding but never rejects', async () => {
    const source = seededSource();
    const bundle = declareConnector(mockConnectorSpec(source));
    const report = await runCertificationSuite({
      bundle,
      tier: 'community',
      portContext: makeMockContext(),
      sourceLineCount: 12_000,
    });
    const gate = report.steps.find((s) => s.step === 'complexity_gate');
    expect(gate?.passed).toBe(true);
    expect(gate?.findings?.join('\n')).toMatch(/review trigger/);
    expect(report.passed).toBe(true);
  });

  it('undeclared-but-demonstrated capabilities surface as findings, not failures', async () => {
    const source = seededSource();
    const spec = mockConnectorSpec(source);
    const bundle = declareConnector({
      ...spec,
      // Honest but modest: implements everything, declares only content.
      supports: { changeFeed: true, content: true },
    });
    const report = await runCertificationSuite({
      bundle,
      tier: 'community',
      portContext: makeMockContext(),
    });
    const truth = report.steps.find((s) => s.step === 'manifest_truthfulness');
    expect(truth?.passed).toBe(true);
    expect(truth?.findings?.join('\n')).toMatch(/demonstrated but not declared/);
    expect(report.passed).toBe(true);
  });

  it('catalog entry carries the additive manifest fields (and only when declared)', () => {
    const source = seededSource();
    const k1Entry = declareConnector(mockConnectorSpec(source)).catalogEntry;
    expect(k1Entry.enablementTier).toBe(1);
    expect(k1Entry.heartbeatSeconds).toBe(300);
    expect(k1Entry.sdkVersion).toBe(SDK_VERSION);
    expect(k1Entry.supports?.['changeFeed']).toBe(true);

    const d4Entry = declareConnector({
      connectorId: 'legacy-d4',
      displayName: 'Legacy',
      category: 'custom',
      description: 'a pre-K.1 connector',
      catalogVersion: '1.0.0',
      credentialSchema: { type: 'object' },
      certificationTarget: 'experimental',
      capabilities: [
        {
          capabilityId: 'do-thing',
          summary: 'does a thing',
          actionClass: 'comm.internal_note',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          invoke: async () => ({ status: 'ok' }),
        },
      ],
    }).catalogEntry;
    expect('supports' in d4Entry).toBe(false);
    expect('enablementTier' in d4Entry).toBe(false);
  });

  it('declareConnector enforces the K.1 structural invariants', () => {
    const source = seededSource();
    const spec = mockConnectorSpec(source);
    expect(() =>
      declareConnector({ ...spec, enablementTier: 3 as unknown as 0 }),
    ).toThrow(/enablementTier/);
    expect(() =>
      declareConnector({ ...spec, heartbeatSeconds: 0 }),
    ).toThrow(/heartbeatSeconds/);
    const missingUnregister = { ...spec };
    delete (missingUnregister as Partial<DeclareConnectorSpec>).unregisterWebhook;
    expect(() => declareConnector(missingUnregister)).toThrow(/both be declared/);
  });

  it('N/N−1 sdkVersion window', () => {
    expect(isSdkVersionCompatible('1.0.0', '1.1.0').compatible).toBe(true);
    expect(isSdkVersionCompatible('0.9.0', '1.1.0').compatible).toBe(true);   // N−1
    expect(isSdkVersionCompatible('2.0.0', '1.1.0').compatible).toBe(false);  // future
    expect(isSdkVersionCompatible('2.0.0', '4.0.0').compatible).toBe(false);  // too old
    expect(isSdkVersionCompatible('not-a-version').compatible).toBe(false);
    expect(isSdkVersionCompatible('2.0.0', '1.1.0').reason).toMatch(/upgrade the platform|build against/);
  });
});
