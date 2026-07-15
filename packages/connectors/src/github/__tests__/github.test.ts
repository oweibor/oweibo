/**
 * K.9 — github connector conformance: certification, delta-sync via the
 * updated_at watermark, collaborator → grant mapping with GitHub's permission
 * levels folded onto read/write/owner.
 */
import { runCertificationSuite, makeMockContext } from '@oweibo/connector-sdk';
import { makeGithubBundle } from '../connector.js';
import { InMemoryGithubClient } from '../githubClient.js';
import { collaboratorsToGrants, hashGrants } from '../ports.js';

function seededGithub(): InMemoryGithubClient {
  const gh = new InMemoryGithubClient({ pageSize: 2 });
  gh.setCollaborators('acme/api', [
    { login: 'ada', permission: 'admin' },
    { login: 'bob', permission: 'write' },
    { login: 'carol', permission: 'read' },
  ]);
  gh.putIssue({ repo: 'acme/api', number: 1, title: 'flaky test', body: 'CI is red', author: 'bob', state: 'open', updatedAt: '2026-07-10T10:00:00Z' });
  gh.putIssue({ repo: 'acme/api', number: 2, title: 'add metrics', body: 'p95 dashboard', author: 'ada', state: 'open', updatedAt: '2026-07-11T09:00:00Z' });
  return gh;
}

describe('github connector', () => {
  it('passes full certification: changeFeed + content + acl + deltaSync demonstrated', async () => {
    const bundle = makeGithubBundle(() => seededGithub());
    const report = await runCertificationSuite({
      bundle,
      tier: 'community',
      portContext: makeMockContext(),
    });
    const byStep = Object.fromEntries(report.steps.map((s) => [s.step, s]));
    expect(byStep['port_contract_tests']?.passed).toBe(true);
    expect(byStep['manifest_truthfulness']?.passed).toBe(true);
    expect(report.passed).toBe(true);
  });

  it('the issues feed is a real delta feed: tail cursor resumes with only new/updated issues', async () => {
    const gh = seededGithub();
    const bundle = makeGithubBundle(() => gh);
    const port = bundle.spec.ports!.changeFeed!;
    const ctx = makeMockContext();

    let cursor: string | null = null;
    const seen: string[] = [];
    for (;;) {
      const page = await port.listChanges(ctx, cursor);
      seen.push(...page.items.map((i) => `${i.kind}:${i.ref}`));
      if (page.items.length === 0 && page.nextCursor !== null) { cursor = page.nextCursor; break; }
      if (page.nextCursor === null) { cursor = null; break; }
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(['created:acme/api#1', 'created:acme/api#2']);
    expect(cursor).not.toBeNull();

    gh.touchIssue('acme/api', 1, '2026-07-12T12:00:00Z');
    const delta = await port.listChanges(ctx, cursor);
    expect(delta.items).toEqual([
      { ref: 'acme/api#1', kind: 'updated', sourceRevision: '2026-07-12T12:00:00Z', occurredAt: '2026-07-12T12:00:00Z' },
    ]);
  });

  it('content port returns issue fields + updated_at as revision', async () => {
    const bundle = makeGithubBundle(() => seededGithub());
    const r = await bundle.spec.ports!.content!.fetchContent(makeMockContext(), 'acme/api#1');
    expect(r.fields).toEqual({
      title: 'flaky test',
      body: 'CI is red',
      author: 'bob',
      state: 'open',
      repo: 'acme/api',
    });
    expect(r.revision).toBe('2026-07-10T10:00:00Z');
  });

  it('collaborator permissions fold onto read/write/owner (§6.2 grant mapping)', () => {
    const grants = collaboratorsToGrants([
      { login: 'ada', permission: 'admin' },
      { login: 'bob', permission: 'write' },
      { login: 'carol', permission: 'read' },
      { login: 'dave', permission: 'maintain' },
      { login: 'eve', permission: 'triage' },
    ]);
    expect(grants).toEqual([
      { principal: 'ada', kind: 'user', access: 'owner' },
      { principal: 'bob', kind: 'user', access: 'write' },
      { principal: 'carol', kind: 'user', access: 'read' },
      { principal: 'dave', kind: 'user', access: 'owner' },
      { principal: 'eve', kind: 'user', access: 'write' },
    ]);
    const h1 = hashGrants(grants);
    expect(hashGrants([...grants].reverse())).toBe(h1);      // order-independent
    expect(hashGrants(grants.slice(0, 3))).not.toBe(h1);     // change-sensitive
  });

  it('acl port maps repo collaborators to grants (an issue is visible to its repo)', async () => {
    const bundle = makeGithubBundle(() => seededGithub());
    const snap = await bundle.spec.ports!.acl!.fetchAcl(makeMockContext(), 'acme/api#1');
    expect(snap.principals).toEqual([
      { principal: 'ada', kind: 'user', access: 'owner' },
      { principal: 'bob', kind: 'user', access: 'write' },
      { principal: 'carol', kind: 'user', access: 'read' },
    ]);
    expect(snap.aclVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
