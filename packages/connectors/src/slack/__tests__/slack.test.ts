/**
 * K.9 — slack connector conformance: certification (Glean face, zero
 * capabilities), delta-sync demonstration via the resumable history cursor,
 * channel-membership → grant mapping + §6.2 grant hashing.
 */
import { runCertificationSuite, makeMockContext } from '@oweibo/connector-sdk';
import { makeSlackBundle } from '../connector.js';
import { InMemorySlackClient } from '../slackClient.js';
import { membersToGrants, hashGrants } from '../ports.js';

function seededSlack(): InMemorySlackClient {
  const slack = new InMemorySlackClient({ pageSize: 2 });
  slack.setMembers('C-eng', ['U-ada', 'U-bob']);
  slack.setMembers('C-random', ['U-ada', 'U-bob', 'U-carol']);
  slack.postMessage({ channelId: 'C-eng', ts: '1720000000.000100', text: 'ship K.9', userId: 'U-ada' });
  slack.postMessage({ channelId: 'C-random', ts: '1720000001.000200', text: 'lunch?', userId: 'U-carol' });
  return slack;
}

describe('slack connector', () => {
  it('passes full certification: changeFeed + content + acl + deltaSync demonstrated', async () => {
    const bundle = makeSlackBundle(() => seededSlack());
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

  it('the history feed is a real delta feed: tail cursor resumes with only new messages', async () => {
    const slack = seededSlack();
    const bundle = makeSlackBundle(() => slack);
    const port = bundle.spec.ports!.changeFeed!;
    const ctx = makeMockContext();

    // Drain the initial crawl to the delta tail.
    let cursor: string | null = null;
    const seen: string[] = [];
    for (;;) {
      const page = await port.listChanges(ctx, cursor);
      seen.push(...page.items.map((i) => `${i.kind}:${i.ref}`));
      if (page.items.length === 0 && page.nextCursor !== null) { cursor = page.nextCursor; break; }
      if (page.nextCursor === null) { cursor = null; break; }
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(['created:C-eng:1720000000.000100', 'created:C-random:1720000001.000200']);
    expect(cursor).not.toBeNull();

    // A new message lands; polling the tail returns ONLY it.
    slack.postMessage({ channelId: 'C-eng', ts: '1720000002.000300', text: 'follow-up', userId: 'U-bob' });
    const delta = await port.listChanges(ctx, cursor);
    expect(delta.items).toHaveLength(1);
    expect(delta.items[0]).toMatchObject({ ref: 'C-eng:1720000002.000300', kind: 'created' });
  });

  it('edits surface as updated events with the edited ts as revision', async () => {
    const slack = seededSlack();
    const bundle = makeSlackBundle(() => slack);
    const port = bundle.spec.ports!.changeFeed!;
    const ctx = makeMockContext();

    let cursor: string | null = null;
    for (;;) {
      const page = await port.listChanges(ctx, cursor);
      if (page.items.length === 0 && page.nextCursor !== null) { cursor = page.nextCursor; break; }
      if (page.nextCursor === null) throw new Error('slack feed unexpectedly non-resumable');
      cursor = page.nextCursor;
    }

    slack.editMessage('C-eng', '1720000000.000100', 'ship K.9 today', '1720000003.000400');
    const delta = await port.listChanges(ctx, cursor);
    expect(delta.items).toEqual([
      { ref: 'C-eng:1720000000.000100', kind: 'updated', sourceRevision: '1720000003.000400' },
    ]);
  });

  it('deletions surface as deleted change events', async () => {
    const slack = seededSlack();
    const bundle = makeSlackBundle(() => slack);
    const port = bundle.spec.ports!.changeFeed!;
    const ctx = makeMockContext();

    let cursor: string | null = null;
    for (;;) {
      const page = await port.listChanges(ctx, cursor);
      if (page.items.length === 0 && page.nextCursor !== null) { cursor = page.nextCursor; break; }
      if (page.nextCursor === null) throw new Error('slack feed unexpectedly non-resumable');
      cursor = page.nextCursor;
    }
    slack.deleteMessage('C-random', '1720000001.000200');
    const delta = await port.listChanges(ctx, cursor);
    expect(delta.items).toEqual([{ ref: 'C-random:1720000001.000200', kind: 'deleted' }]);
  });

  it('content port returns message fields + the edited/ts as revision', async () => {
    const bundle = makeSlackBundle(() => seededSlack());
    const r = await bundle.spec.ports!.content!.fetchContent(makeMockContext(), 'C-eng:1720000000.000100');
    expect(r.fields).toEqual({
      text: 'ship K.9',
      author: 'U-ada',
      channel: 'C-eng',
      ts: '1720000000.000100',
    });
    expect(r.revision).toBe('1720000000.000100');
  });

  it('acl port maps channel membership to read grants (a message is visible to its channel)', async () => {
    const bundle = makeSlackBundle(() => seededSlack());
    const snap = await bundle.spec.ports!.acl!.fetchAcl(makeMockContext(), 'C-eng:1720000000.000100');
    expect(snap.principals).toEqual([
      { principal: 'U-ada', kind: 'user', access: 'read' },
      { principal: 'U-bob', kind: 'user', access: 'read' },
    ]);
    expect(snap.aclVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('grant hash is order-independent and change-sensitive (§6.2)', () => {
    const g = membersToGrants(['U-ada', 'U-bob', 'U-carol']);
    const h1 = hashGrants(g);
    const h2 = hashGrants([...g].reverse());
    expect(h2).toBe(h1);                          // canonicalized
    expect(hashGrants(g.slice(0, 2))).not.toBe(h1); // change-sensitive
  });
});
