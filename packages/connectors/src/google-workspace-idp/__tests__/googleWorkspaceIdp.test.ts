/**
 * K.2 — google-workspace-idp connector conformance:
 * certification (identity-only, zero capabilities), per-port contract,
 * nesting edges, OIDC claim mapping, and the INV-15 lying-manifest case.
 */
import {
  runCertificationSuite,
  runPortContractTests,
  makeMockContext,
} from '@oweibo/connector-sdk';
import { makeGoogleWorkspaceIdpBundle } from '../connector.js';
import { InMemoryDirectoryClient } from '../directoryClient.js';
import { mapOidcLoginClaims } from '../claims.js';

function seededDirectory(): InMemoryDirectoryClient {
  const dir = new InMemoryDirectoryClient({ pageSize: 2 });
  dir.addUser({ id: 'u-ada', primaryEmail: 'Ada@Acme.Test', name: 'Ada L' });
  dir.addUser({ id: 'u-bob', primaryEmail: 'bob@acme.test', suspended: true });
  dir.addUser({ id: 'u-eve', primaryEmail: 'eve@acme.test' });
  dir.addGroup({ id: 'g-eng', name: 'Engineering' }, [
    { id: 'u-ada', type: 'USER' },
    { id: 'g-core', type: 'GROUP' },       // nested
  ]);
  dir.addGroup({ id: 'g-core', name: 'Core' }, [{ id: 'u-eve', type: 'USER' }]);
  dir.addGroup({ id: 'g-all', name: 'Everyone' }, [
    { id: 'g-eng', type: 'GROUP' },
    { id: 'u-bob', type: 'USER' },
    { id: 'c-domain', type: 'CUSTOMER' },  // grant marker, never an edge
  ]);
  return dir;
}

describe('google-workspace-idp', () => {
  it('passes full certification as an identity-only connector (zero capabilities)', async () => {
    const bundle = makeGoogleWorkspaceIdpBundle(() => seededDirectory());
    const report = await runCertificationSuite({
      bundle,
      tier: 'community',
      portContext: makeMockContext(),
    });
    const byStep = Object.fromEntries(report.steps.map((s) => [s.step, s]));
    expect(byStep['schema_validation']?.passed).toBe(true);   // zero caps + ports = legal
    expect(byStep['port_contract_tests']?.passed).toBe(true);
    expect(byStep['manifest_truthfulness']?.passed).toBe(true);
    expect(report.passed).toBe(true);
  });

  it('a lying variant (declares webhooks it does not implement) fails certification', async () => {
    const honest = makeGoogleWorkspaceIdpBundle(() => seededDirectory());
    const lying = { ...honest, spec: { ...honest.spec, supports: { principals: true, groups: true, webhooks: true } } };
    const report = await runCertificationSuite({
      bundle: lying,
      tier: 'community',
      portContext: makeMockContext(),
    });
    expect(report.passed).toBe(false);
    const truth = report.steps.find((s) => s.step === 'manifest_truthfulness');
    expect(truth?.violations.join('\n')).toMatch(/webhooks/);
  });

  it('port contract: principals + groups demonstrated; nesting stays raw edges', async () => {
    const bundle = makeGoogleWorkspaceIdpBundle(() => seededDirectory());
    const report = await runPortContractTests(bundle, makeMockContext());
    expect(report.violations).toEqual([]);
    expect(report.demonstrated).toMatchObject({ principals: true, groups: true });

    const port = bundle.spec.ports!.principals!;
    const ctx = makeMockContext();

    // Principals: status mapping + lowercased email.
    const users: Array<{ id: string; email?: string; status: string }> = [];
    let cursor: string | null = null;
    do {
      const page = await port.listPrincipals(ctx, cursor);
      users.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(users).toHaveLength(3);
    expect(users.find((u) => u.id === 'u-ada')?.email).toBe('ada@acme.test');
    expect(users.find((u) => u.id === 'u-bob')?.status).toBe('suspended');

    // Groups: nested edges preserved, CUSTOMER markers dropped, members
    // drained across the in-memory client's 2-item pages.
    const groups = new Map<string, { memberPrincipals: readonly string[]; memberGroups: readonly string[] }>();
    cursor = null;
    do {
      const page = await port.listGroups!(ctx, cursor);
      for (const g of page.items) groups.set(g.id, g);
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect([...groups.keys()].sort()).toEqual(['g-all', 'g-core', 'g-eng']);
    expect(groups.get('g-eng')).toMatchObject({ memberPrincipals: ['u-ada'], memberGroups: ['g-core'] });
    expect(groups.get('g-all')?.memberGroups).toEqual(['g-eng']);
    expect(groups.get('g-all')?.memberPrincipals).toEqual(['u-bob']);  // CUSTOMER dropped
  });

  it('probe reports unhealthy with detail instead of throwing', async () => {
    const bundle = makeGoogleWorkspaceIdpBundle(() => {
      throw new Error('no credentials resolved');
    });
    const probe = await bundle.spec.ports!.principals!.probe(makeMockContext());
    expect(probe.ok).toBe(false);
    expect(probe.detail).toMatch(/no credentials/);
  });

  it('validateConnection reflects the probe (pending→active driver)', async () => {
    const good = makeGoogleWorkspaceIdpBundle(() => seededDirectory());
    await expect(good.spec.validateConnection!(makeMockContext())).resolves.toMatchObject({
      ok: true,
      effectiveSupports: { principals: true, groups: true },
    });
    const bad = makeGoogleWorkspaceIdpBundle(() => {
      throw new Error('boom');
    });
    await expect(bad.spec.validateConnection!(makeMockContext())).resolves.toMatchObject({ ok: false });
  });
});

describe('mapOidcLoginClaims (ADR-010 §3.6 — login identity ONLY)', () => {
  it('maps sub + verified email; lowercases the seed', () => {
    expect(mapOidcLoginClaims({ sub: 'g-123', email: 'Ada@Acme.Test', email_verified: true }))
      .toEqual({ ok: true, principalId: 'g-123', verifiedEmail: 'ada@acme.test' });
  });

  it('an unverified email is not a seed', () => {
    expect(mapOidcLoginClaims({ sub: 'g-123', email: 'ada@acme.test', email_verified: false }))
      .toEqual({ ok: true, principalId: 'g-123', verifiedEmail: null });
  });

  it('refuses a missing sub and a wrong hosted domain', () => {
    expect(mapOidcLoginClaims({ sub: '' }).ok).toBe(false);
    const wrongDomain = mapOidcLoginClaims({ sub: 'g-1', hd: 'other.test' }, 'acme.test');
    expect(wrongDomain.ok).toBe(false);
    if (!wrongDomain.ok) expect(wrongDomain.reason).toMatch(/acme\.test/);
  });

  it('has no path through which a groups claim could arrive (structural)', () => {
    // The claim shape simply has no groups field; passing one is inert.
    const mapped = mapOidcLoginClaims({ sub: 'g-1', groups: ['g-evil'] } as never);
    expect(mapped.ok).toBe(true);
    expect(JSON.stringify(mapped)).not.toContain('g-evil');
  });
});
