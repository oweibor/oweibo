/**
 * K.9 — the connector simulation environment, exercised against the two new
 * Tier-0 connectors. Certification proves each port in isolation; the simulator
 * drives the full Glean lifecycle (crawl → index → ACL snapshot → mutate →
 * delta resume) the way the runtime composes them.
 *
 * This is the "real test" the roadmap's effort budgets are measured against: a
 * connector-agnostic harness both connectors pass without a bespoke driver.
 */
import { simulateConnector } from '@oweibo/connector-sdk';
import { makeSlackBundle } from '../slack/connector.js';
import { InMemorySlackClient } from '../slack/slackClient.js';
import { makeGithubBundle } from '../github/connector.js';
import { InMemoryGithubClient } from '../github/githubClient.js';

describe('connector simulation environment', () => {
  it('drives Slack end-to-end: crawl → index → ACL → delta resume on a new message', async () => {
    const slack = new InMemorySlackClient({ pageSize: 2 });
    slack.setMembers('C-eng', ['U-ada', 'U-bob']);
    slack.postMessage({ channelId: 'C-eng', ts: '1720000000.000100', text: 'hello', userId: 'U-ada' });
    slack.postMessage({ channelId: 'C-eng', ts: '1720000000.000200', text: 'world', userId: 'U-bob' });

    const report = await simulateConnector(makeSlackBundle(() => slack), {
      mutate: () => slack.postMessage({ channelId: 'C-eng', ts: '1720000001.000300', text: 'new', userId: 'U-ada' }),
    });

    expect(report.indexed.map((o) => o.ref).sort()).toEqual(['C-eng:1720000000.000100', 'C-eng:1720000000.000200']);
    // Every indexed object carries an ACL snapshot (its channel's membership).
    for (const o of report.indexed) {
      expect(o.acl!.principals).toEqual([
        { principal: 'U-ada', kind: 'user', access: 'read' },
        { principal: 'U-bob', kind: 'user', access: 'read' },
      ]);
    }
    expect(report.deltaResumable).toBe(true);
    // The tail poll saw ONLY the new message — delta resume, not full re-crawl.
    expect(report.deltaAfterMutation).toEqual([
      { ref: 'C-eng:1720000001.000300', kind: 'created', sourceRevision: '1720000001.000300' },
    ]);
  });

  it('drives GitHub end-to-end: crawl → index → ACL → delta resume on an issue update', async () => {
    const gh = new InMemoryGithubClient({ pageSize: 2 });
    gh.setCollaborators('acme/api', [{ login: 'ada', permission: 'admin' }, { login: 'bob', permission: 'read' }]);
    gh.putIssue({ repo: 'acme/api', number: 1, title: 'a', body: 'x', author: 'ada', state: 'open', updatedAt: '2026-07-10T10:00:00Z' });
    gh.putIssue({ repo: 'acme/api', number: 2, title: 'b', body: 'y', author: 'bob', state: 'open', updatedAt: '2026-07-11T10:00:00Z' });

    const report = await simulateConnector(makeGithubBundle(() => gh), {
      mutate: () => gh.touchIssue('acme/api', 1, '2026-07-12T10:00:00Z'),
    });

    expect(report.indexed.map((o) => o.ref).sort()).toEqual(['acme/api#1', 'acme/api#2']);
    expect(report.indexed[0]!.acl!.principals).toEqual([
      { principal: 'ada', kind: 'user', access: 'owner' },
      { principal: 'bob', kind: 'user', access: 'read' },
    ]);
    expect(report.deltaResumable).toBe(true);
    expect(report.deltaAfterMutation).toEqual([
      { ref: 'acme/api#1', kind: 'updated', sourceRevision: '2026-07-12T10:00:00Z', occurredAt: '2026-07-12T10:00:00Z' },
    ]);
  });

  it('a deleted object is not indexed (a crawl tombstone cancels an earlier create)', async () => {
    const slack = new InMemorySlackClient({ pageSize: 2 });
    slack.setMembers('C-eng', ['U-ada']);
    slack.postMessage({ channelId: 'C-eng', ts: '1720000000.000100', text: 'temp', userId: 'U-ada' });
    slack.deleteMessage('C-eng', '1720000000.000100');

    const report = await simulateConnector(makeSlackBundle(() => slack));
    expect(report.indexed).toHaveLength(0);
  });
});
