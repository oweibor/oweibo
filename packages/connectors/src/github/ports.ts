/**
 * K.9 — the github source-adapter ports over a GithubClient.
 *
 * Same composition as Drive/Slack (ADR-012 §3.2): a null cursor crawls
 * listIssues with the delta watermark captured first, then hands to delta
 * polling. GitHub's updated_at is the revision — pairing (ref, revision) is the
 * ADR-013 idempotency key. The AclPort maps repo collaborators onto the SDK's
 * read/write/owner grants; aclVersion is the §6.2 grant hash.
 */
import { createHash } from 'crypto';
import type {
  AclPort,
  AclPrincipalGrant,
  ChangeEvent,
  ChangeFeedPort,
  ConnectorContext,
  ContentPort,
  Cursor,
  Page,
} from '@oweibo/connector-sdk';
import { PortError } from '@oweibo/connector-sdk';
import type { GithubClient, GithubCollaborator } from './githubClient.js';
import { issueRef, parseIssueRef } from './githubClient.js';

export type GithubClientFactory = (ctx: ConnectorContext) => GithubClient;

export function makeGithubChangeFeedPort(factory: GithubClientFactory): ChangeFeedPort {
  return {
    apiVersion: 'v1',
    probe: async (ctx) => {
      try {
        await factory(ctx).getStartCursor();
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },
    listChanges: async (ctx, cursor: Cursor | null): Promise<Page<ChangeEvent>> => {
      const client = factory(ctx);

      if (cursor === null || cursor.startsWith('crawl:')) {
        let startCursor: string;
        let issuesCursor: string | null;
        if (cursor === null) {
          startCursor = await client.getStartCursor();
          issuesCursor = null;
        } else {
          const [, encStart, encIssues] = cursor.split(':', 3) as [string, string, string?];
          startCursor = decodeURIComponent(encStart);
          issuesCursor = encIssues ? decodeURIComponent(encIssues) : null;
        }
        const page = await client.listIssues(issuesCursor);
        const items = page.issues
          .filter((i) => i.deleted !== true)
          .map((i): ChangeEvent => ({
            ref: issueRef(i.repo, i.number),
            kind: 'created',
            sourceRevision: i.updatedAt,
            occurredAt: i.updatedAt,
          }));
        const nextCursor = page.nextCursor !== null
          ? `crawl:${encodeURIComponent(startCursor)}:${encodeURIComponent(page.nextCursor)}`
          : `delta:${encodeURIComponent(startCursor)}`;
        return { items, nextCursor };
      }

      const token = decodeURIComponent(cursor.replace(/^delta:/, ''));
      const page = await client.listChanges(token);
      const items = page.changes.map((c): ChangeEvent =>
        c.removed
          ? { ref: issueRef(c.repo, c.number), kind: 'deleted' }
          : {
              ref: issueRef(c.repo, c.number),
              // The first log entry for an issue is its creation; a later
              // updated_at bump is an update.
              kind: 'updated',
              sourceRevision: c.issue?.updatedAt,
              occurredAt: c.issue?.updatedAt,
            },
      );
      const next = page.nextCursor ?? page.newStartCursor ?? null;
      return { items, nextCursor: next === null ? null : `delta:${encodeURIComponent(next)}` };
    },
  };
}

export function makeGithubContentPort(factory: GithubClientFactory): ContentPort {
  return {
    apiVersion: 'v1',
    probe: async (ctx) => {
      try {
        await factory(ctx).getStartCursor();
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },
    fetchContent: async (ctx, ref) => {
      const client = factory(ctx);
      let issue;
      try {
        issue = await client.getIssue(ref);
      } catch (err) {
        if (err instanceof PortError) throw err;
        throw PortError.permanent(
          `github issue ${ref} not fetchable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return {
        fields: {
          title: issue.title,
          body: issue.body,
          author: issue.author,
          state: issue.state,
          repo: issue.repo,
        },
        revision: issue.updatedAt,
      };
    },
  };
}

/** GitHub collaborator permission → SDK grant access. */
export function collaboratorsToGrants(collaborators: readonly GithubCollaborator[]): AclPrincipalGrant[] {
  return collaborators.map((c): AclPrincipalGrant => {
    const access = c.permission === 'admin' || c.permission === 'maintain' ? 'owner'
      : c.permission === 'write' || c.permission === 'triage' ? 'write'
      : 'read';
    return { principal: c.login, kind: 'user', access };
  });
}

/** sha256 over the canonicalized grant set — the §6.2 hash (shared convention). */
export function hashGrants(grants: readonly AclPrincipalGrant[]): string {
  const canon = [...grants]
    .map((g) => `${g.kind}:${g.principal}:${g.access}`)
    .sort()
    .join('\n');
  return `sha256:${createHash('sha256').update(canon).digest('hex')}`;
}

export function makeGithubAclPort(factory: GithubClientFactory): AclPort {
  return {
    apiVersion: 'v1',
    probe: async (ctx) => {
      try {
        await factory(ctx).getStartCursor();
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },
    fetchAcl: async (ctx, ref) => {
      const { repo } = parseIssueRef(ref);
      const collaborators = await factory(ctx).repoCollaborators(repo);
      const grants = collaboratorsToGrants(collaborators);
      return { aclVersion: hashGrants(grants), principals: grants };
    },
  };
}
