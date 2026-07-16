/**
 * K.2 — the PrincipalsPort adapter over a DirectoryClient.
 *
 * Thin translation only (P9): Directory users → SourcePrincipal pages;
 * Directory groups + per-group member drains → SourceGroup pages with
 * raw nesting edges (memberGroups). Transitive closure is platform-side
 * (ADR-010 §3.3) — this adapter NEVER flattens.
 *
 * Cursors: the Directory API's own pageToken, passed through opaquely.
 * A null tail means "snapshot listing exhausted" — directory listings
 * are not delta feeds; delta detection is the sync service's diff.
 */
import type {
  ConnectorContext,
  Cursor,
  Page,
  PrincipalsPort,
  SourceGroup,
  SourcePrincipal,
} from '@oweibo/connector-sdk';
import type { DirectoryClient } from './directoryClient.js';

export type DirectoryClientFactory = (ctx: ConnectorContext) => DirectoryClient;

export function makeWorkspacePrincipalsPort(factory: DirectoryClientFactory): PrincipalsPort {
  return {
    apiVersion: 'v1',

    async probe(ctx: ConnectorContext) {
      try {
        await factory(ctx).listUsers(null);
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },

    async listPrincipals(ctx: ConnectorContext, cursor: Cursor | null): Promise<Page<SourcePrincipal>> {
      const page = await factory(ctx).listUsers(cursor);
      return {
        items: page.items.map((u) => ({
          id: u.id,
          email: u.primaryEmail.length > 0 ? u.primaryEmail.toLowerCase() : undefined,
          displayName: u.name,
          status: u.deleted === true ? 'deleted' : u.suspended === true ? 'suspended' : 'active',
        } satisfies SourcePrincipal)),
        nextCursor: page.nextPageToken,
      };
    },

    async listGroups(ctx: ConnectorContext, cursor: Cursor | null): Promise<Page<SourceGroup>> {
      const client = factory(ctx);
      const page = await client.listGroups(cursor);
      const items: SourceGroup[] = [];
      for (const g of page.items) {
        // Drain this group's members fully — a group's edges belong to
        // one page so consumers never see a half-reported group.
        const memberPrincipals: string[] = [];
        const memberGroups: string[] = [];
        let token: string | null = null;
        do {
          const members = await client.listGroupMembers(g.id, token);
          for (const m of members.items) {
            if (m.type === 'USER') memberPrincipals.push(m.id);
            else if (m.type === 'GROUP') memberGroups.push(m.id);
            // CUSTOMER (= "everyone in the domain") is a grant marker,
            // not an edge — the sync layer has no principal for it, and
            // inventing one here would be silent flattening.
          }
          token = members.nextPageToken;
        } while (token !== null);
        items.push({ id: g.id, displayName: g.name, memberPrincipals, memberGroups });
      }
      return { items, nextCursor: page.nextPageToken };
    },
  };
}
