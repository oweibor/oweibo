/**
 * K.3 — the google-drive source-adapter ports over a DriveClient.
 *
 * ChangeFeedPort: Drive's changes API is a real delta feed — the final
 * page carries newStartPageToken, which becomes the standing tail cursor
 * (what demonstrates deltaSync under INV-15).
 *
 * ContentPort (K.3 = metadata-only depth): fields are name/mimeType/
 * modifiedTime; revision is Drive's per-file version — the idempotency
 * key half (ADR-013) and the vector entry (ADR-003).
 *
 * AclPort: permissions.list mapped to grants. Drive has no ACL version;
 * aclVersion is the sha256 of the canonicalized permission set (§6.2
 * hashing convention) — the platform keeps its own monotonic counter and
 * bumps it when this hash changes.
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
import type { DriveClient, DrivePermission } from './driveClient.js';

export type DriveClientFactory = (ctx: ConnectorContext) => DriveClient;

export function makeDriveChangeFeedPort(factory: DriveClientFactory): ChangeFeedPort {
  return {
    apiVersion: 'v1',
    probe: async (ctx) => {
      try {
        await factory(ctx).getStartPageToken();
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },
    listChanges: async (ctx, cursor: Cursor | null): Promise<Page<ChangeEvent>> => {
      const client = factory(ctx);

      // Composition (ADR-012 §3.2: one port, several source APIs): the
      // changes API cannot replay history, so a null cursor runs an
      // initial CRAWL over files.list — with the delta start token
      // captured BEFORE the crawl begins, so changes landing mid-crawl
      // are not lost. Cursor forms:
      //   crawl:<startToken>:<filesPageToken?>   initial crawl in flight
      //   delta:<changesPageToken>               normal delta polling
      if (cursor === null || cursor.startsWith('crawl:')) {
        let startToken: string;
        let filesToken: string | null;
        if (cursor === null) {
          startToken = await client.getStartPageToken();
          filesToken = null;
        } else {
          const [, encodedStart, encodedFiles] = cursor.split(':', 3) as [string, string, string?];
          startToken = decodeURIComponent(encodedStart);
          filesToken = encodedFiles ? decodeURIComponent(encodedFiles) : null;
        }
        const page = await client.listFiles(filesToken);
        const items = page.files
          .filter((f) => f.trashed !== true)
          .map((f): ChangeEvent => ({
            ref: f.id,
            kind: 'created',
            sourceRevision: String(f.version),
            occurredAt: f.modifiedTime,
          }));
        const nextCursor = page.nextPageToken !== null
          ? `crawl:${encodeURIComponent(startToken)}:${encodeURIComponent(page.nextPageToken)}`
          : `delta:${encodeURIComponent(startToken)}`;   // crawl done → hand over to deltas
        return { items, nextCursor };
      }

      const token = decodeURIComponent(cursor.replace(/^delta:/, ''));
      const page = await client.listChanges(token);
      const items = page.changes.map((c): ChangeEvent =>
        c.removed || c.file?.trashed
          ? { ref: c.fileId, kind: 'deleted' }
          : {
              ref: c.fileId,
              kind: c.file && c.file.version === 1 ? 'created' : 'updated',
              sourceRevision: c.file ? String(c.file.version) : undefined,
              occurredAt: c.file?.modifiedTime,
            },
      );
      // Tail: newStartPageToken is the standing resume point (delta sync).
      const next = page.nextPageToken ?? page.newStartPageToken ?? null;
      return { items, nextCursor: next === null ? null : `delta:${encodeURIComponent(next)}` };
    },
  };
}

export function makeDriveContentPort(factory: DriveClientFactory): ContentPort {
  return {
    apiVersion: 'v1',
    probe: async (ctx) => {
      try {
        await factory(ctx).getStartPageToken();
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },
    fetchContent: async (ctx, ref) => {
      const client = factory(ctx);
      let meta;
      try {
        meta = await client.getFile(ref);
      } catch (err) {
        if (err instanceof PortError) throw err;
        throw PortError.permanent(
          `drive file ${ref} not fetchable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // K.3 metadata-only depth: structural fields, no body download.
      return {
        fields: {
          title: meta.name,
          mimeType: meta.mimeType,
          modifiedTime: meta.modifiedTime,
        },
        revision: String(meta.version),
      };
    },
  };
}

/** Canonical grant mapping. domain/anyone become group-kind markers. */
export function mapPermissions(perms: readonly DrivePermission[]): AclPrincipalGrant[] {
  return perms.map((p): AclPrincipalGrant => {
    const access = p.role === 'owner' || p.role === 'organizer' ? 'owner'
      : p.role === 'writer' || p.role === 'fileOrganizer' ? 'write'
      : 'read';
    if (p.type === 'user') return { principal: p.emailAddress ?? p.id, kind: 'user', access };
    if (p.type === 'group') return { principal: p.emailAddress ?? p.id, kind: 'group', access };
    if (p.type === 'domain') return { principal: `domain:${p.domain ?? ''}`, kind: 'group', access };
    return { principal: 'anyone', kind: 'group', access };
  });
}

/** sha256 over the canonicalized (sorted) grant set — the §6.2 hash. */
export function hashGrants(grants: readonly AclPrincipalGrant[]): string {
  const canon = [...grants]
    .map((g) => `${g.kind}:${g.principal}:${g.access}`)
    .sort()
    .join('\n');
  return `sha256:${createHash('sha256').update(canon).digest('hex')}`;
}

export function makeDriveAclPort(factory: DriveClientFactory): AclPort {
  return {
    apiVersion: 'v1',
    probe: async (ctx) => {
      try {
        await factory(ctx).getStartPageToken();
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },
    fetchAcl: async (ctx, ref) => {
      const perms = await factory(ctx).listPermissions(ref);
      const principals = mapPermissions(perms);
      return { aclVersion: hashGrants(principals), principals };
    },
  };
}
