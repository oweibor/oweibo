/**
 * K.3 — google-drive connector conformance: certification (Glean face,
 * zero capabilities), delta-sync demonstration via the changes API's
 * standing start token, permission mapping + §6.2 grant hashing.
 */
import { runCertificationSuite, runPortContractTests, makeMockContext } from '@oweibo/connector-sdk';
import { makeGoogleDriveBundle } from '../connector.js';
import { InMemoryDriveClient } from '../driveClient.js';
import { hashGrants, mapPermissions } from '../ports.js';

function seededDrive(): InMemoryDriveClient {
  const drive = new InMemoryDriveClient({ pageSize: 2 });
  drive.putFile(
    { id: 'f-plan', name: 'Q3 Plan', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-07-10T10:00:00Z' },
    [
      { id: 'p1', type: 'user', emailAddress: 'ada@acme.test', role: 'owner' },
      { id: 'p2', type: 'group', emailAddress: 'eng@acme.test', role: 'reader' },
    ],
  );
  drive.putFile(
    { id: 'f-handbook', name: 'Handbook', mimeType: 'application/pdf', modifiedTime: '2026-07-09T09:00:00Z' },
    [{ id: 'p3', type: 'domain', domain: 'acme.test', role: 'reader' }],
  );
  return drive;
}

describe('google-drive connector', () => {
  it('passes full certification: changeFeed + content + acl + deltaSync demonstrated', async () => {
    const bundle = makeGoogleDriveBundle(() => seededDrive());
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

  it('the changes feed is a real delta feed: tail cursor resumes with only new changes', async () => {
    const drive = seededDrive();
    const bundle = makeGoogleDriveBundle(() => drive);
    const port = bundle.spec.ports!.changeFeed!;
    const ctx = makeMockContext();

    // Drain to tail.
    let cursor: string | null = null;
    const seen: string[] = [];
    for (;;) {
      const page = await port.listChanges(ctx, cursor);
      seen.push(...page.items.map((i) => `${i.kind}:${i.ref}`));
      if (page.items.length === 0 && page.nextCursor !== null) { cursor = page.nextCursor; break; }
      if (page.nextCursor === null) { cursor = null; break; }
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(['created:f-plan', 'created:f-handbook']);
    expect(cursor).not.toBeNull();

    // A change lands; polling the tail returns ONLY it.
    drive.touchFile('f-plan');
    const delta = await port.listChanges(ctx, cursor);
    expect(delta.items).toHaveLength(1);
    expect(delta.items[0]).toMatchObject({ ref: 'f-plan', kind: 'updated', sourceRevision: '2' });
  });

  it('deletions surface as deleted change events on the delta feed', async () => {
    const drive = seededDrive();
    const bundle = makeGoogleDriveBundle(() => drive);
    const port = bundle.spec.ports!.changeFeed!;
    const ctx = makeMockContext();

    // Drain the initial crawl to the delta tail.
    let cursor: string | null = null;
    for (;;) {
      const page = await port.listChanges(ctx, cursor);
      if (page.items.length === 0 && page.nextCursor !== null) { cursor = page.nextCursor; break; }
      if (page.nextCursor === null) throw new Error('drive feed unexpectedly non-resumable');
      cursor = page.nextCursor;
    }

    // A deletion lands; the tail poll reports it.
    drive.deleteFile('f-handbook');
    const delta = await port.listChanges(ctx, cursor);
    expect(delta.items).toEqual([{ ref: 'f-handbook', kind: 'deleted' }]);

    // A fresh crawl (new install) correctly does NOT see historical
    // deletions — only the files that exist now.
    const fresh = await port.listChanges(ctx, null);
    expect(fresh.items.map((i) => i.ref)).toEqual(['f-plan']);
  });

  it('permission mapping + grant hash: order-independent, change-sensitive (§6.2)', () => {
    const grants = mapPermissions([
      { id: 'p1', type: 'user', emailAddress: 'ada@acme.test', role: 'owner' },
      { id: 'p2', type: 'group', emailAddress: 'eng@acme.test', role: 'reader' },
      { id: 'p3', type: 'domain', domain: 'acme.test', role: 'reader' },
      { id: 'p4', type: 'anyone', role: 'commenter' },
    ]);
    expect(grants).toEqual([
      { principal: 'ada@acme.test', kind: 'user', access: 'owner' },
      { principal: 'eng@acme.test', kind: 'group', access: 'read' },
      { principal: 'domain:acme.test', kind: 'group', access: 'read' },
      { principal: 'anyone', kind: 'group', access: 'read' },
    ]);
    const h1 = hashGrants(grants);
    const h2 = hashGrants([...grants].reverse());
    expect(h2).toBe(h1);                                   // canonicalized
    const h3 = hashGrants(grants.slice(0, 3));
    expect(h3).not.toBe(h1);                               // change-sensitive
    expect(h1).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('content port returns metadata fields + the Drive version as revision', async () => {
    const bundle = makeGoogleDriveBundle(() => seededDrive());
    const r = await bundle.spec.ports!.content!.fetchContent(makeMockContext(), 'f-plan');
    expect(r.fields).toEqual({
      title: 'Q3 Plan',
      mimeType: 'application/vnd.google-apps.document',
      modifiedTime: '2026-07-10T10:00:00Z',
    });
    expect(r.revision).toBe('1');
  });
});
