/**
 * K.9 — the slack source-adapter ports over a SlackClient.
 *
 * ChangeFeedPort: a resumable message history feed. A null cursor runs the
 * initial crawl over listMessages with the delta start cursor captured BEFORE
 * the crawl (same composition rule Drive uses, ADR-012 §3.2), then hands over
 * to delta polling — the tail cursor is the standing resume point (deltaSync).
 *
 * ContentPort: message text + author + timestamps. Slack's ts doubles as the
 * revision (an edit yields editedTs); pairing (ref, revision) is the ADR-013
 * idempotency key.
 *
 * AclPort: a message's audience is its channel's membership. Slack has no
 * per-message ACL version, so aclVersion is the sha256 of the canonicalized
 * grant set (§6.2), shared with Drive via the SDK-side hashGrants convention.
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
import type { SlackClient } from './slackClient.js';
import { parseMessageRef, messageRef } from './slackClient.js';

export type SlackClientFactory = (ctx: ConnectorContext) => SlackClient;

export function makeSlackChangeFeedPort(factory: SlackClientFactory): ChangeFeedPort {
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

      // Cursor forms:
      //   crawl:<startCursor>:<messagesCursor?>   initial crawl in flight
      //   delta:<changesCursor>                   normal delta polling
      if (cursor === null || cursor.startsWith('crawl:')) {
        let startCursor: string;
        let messagesCursor: string | null;
        if (cursor === null) {
          startCursor = await client.getStartCursor();
          messagesCursor = null;
        } else {
          const [, encStart, encMsgs] = cursor.split(':', 3) as [string, string, string?];
          startCursor = decodeURIComponent(encStart);
          messagesCursor = encMsgs ? decodeURIComponent(encMsgs) : null;
        }
        const page = await client.listMessages(messagesCursor);
        const items = page.messages
          .filter((m) => m.deleted !== true)
          .map((m): ChangeEvent => ({
            ref: messageRef(m.channelId, m.ts),
            kind: 'created',
            sourceRevision: m.editedTs ?? m.ts,
            occurredAt: new Date(Number(m.ts.split('.')[0]) * 1000).toISOString(),
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
          ? { ref: messageRef(c.channelId, c.ts), kind: 'deleted' }
          : {
              ref: messageRef(c.channelId, c.ts),
              kind: c.message?.editedTs ? 'updated' : 'created',
              sourceRevision: c.message?.editedTs ?? c.message?.ts,
            },
      );
      const next = page.nextCursor ?? page.newStartCursor ?? null;
      return { items, nextCursor: next === null ? null : `delta:${encodeURIComponent(next)}` };
    },
  };
}

export function makeSlackContentPort(factory: SlackClientFactory): ContentPort {
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
      let msg;
      try {
        msg = await client.getMessage(ref);
      } catch (err) {
        if (err instanceof PortError) throw err;
        throw PortError.permanent(
          `slack message ${ref} not fetchable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return {
        fields: {
          text: msg.text,
          author: msg.userId,
          channel: msg.channelId,
          ts: msg.ts,
        },
        revision: msg.editedTs ?? msg.ts,
      };
    },
  };
}

/** Channel membership → read grants. Slack messages are read-only to members. */
export function membersToGrants(userIds: readonly string[]): AclPrincipalGrant[] {
  return userIds.map((u): AclPrincipalGrant => ({ principal: u, kind: 'user', access: 'read' }));
}

/** sha256 over the canonicalized (sorted) grant set — the §6.2 hash (shared convention with Drive). */
export function hashGrants(grants: readonly AclPrincipalGrant[]): string {
  const canon = [...grants]
    .map((g) => `${g.kind}:${g.principal}:${g.access}`)
    .sort()
    .join('\n');
  return `sha256:${createHash('sha256').update(canon).digest('hex')}`;
}

export function makeSlackAclPort(factory: SlackClientFactory): AclPort {
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
      // A message's audience is its channel's membership.
      const { channelId } = parseMessageRef(ref);
      const members = await factory(ctx).channelMembers(channelId);
      const grants = membersToGrants(members);
      return { aclVersion: hashGrants(grants), principals: grants };
    },
  };
}
