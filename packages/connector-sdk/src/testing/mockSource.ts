/**
 * K.1 — MockSourceAdapter: an in-memory "source system" plus factory
 * methods producing conformant port implementations over it. It is the
 * fixture set the certification battery exercises ports against, and the
 * reference adapter authors read before writing a real one.
 *
 * Semantics deliberately mirror a real delta-capable source:
 *   - the change feed is an append-only log; cursors are log offsets
 *     (opaque strings to callers)
 *   - draining to the tail returns an EMPTY page whose nextCursor is the
 *     tail offset — the resume point that demonstrates deltaSync
 *   - mutations (addDocument / updateAcl / recordActivity) append feed
 *     entries, so "poll later, get only what changed" is testable
 */
import type { ConnectorContext } from '../context.js';
import type { ChangeEvent, ChangeFeedPort } from '../ports/changeFeed.js';
import type { ContentPort, ContentResult } from '../ports/content.js';
import type { AclPort, AclSnapshot } from '../ports/acl.js';
import type { PrincipalsPort, SourceGroup, SourcePrincipal } from '../ports/principals.js';
import type { ActivityEvent, ActivityPort } from '../ports/activity.js';
import type { Cursor, Page } from '../ports/types.js';
import { PortError } from '../ports/types.js';

export interface MockDocument {
  readonly ref: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly revision: string;
}

export interface MockSourceSeed {
  readonly documents?: readonly MockDocument[];
  readonly acls?: Readonly<Record<string, AclSnapshot>>;
  readonly principals?: readonly SourcePrincipal[];
  readonly groups?: readonly SourceGroup[];
  readonly activity?: readonly ActivityEvent[];
  /** Items per page across all listings. Default 2 (forces multi-page paths). */
  readonly pageSize?: number;
}

export class MockSourceAdapter {
  private readonly docs = new Map<string, MockDocument>();
  private readonly acls = new Map<string, AclSnapshot>();
  private readonly principals: SourcePrincipal[] = [];
  private readonly groups: SourceGroup[] = [];
  private readonly activity: ActivityEvent[] = [];
  private readonly feed: ChangeEvent[] = [];
  private readonly pageSize: number;
  /** Webhook registrations, keyed by tenantConnectorId — lets tests
   *  assert the register/unregister round-trip actually happened. */
  readonly webhookRegistrations = new Set<string>();

  constructor(seed: MockSourceSeed = {}) {
    this.pageSize = seed.pageSize ?? 2;
    for (const d of seed.documents ?? []) this.addDocument(d);
    for (const [ref, acl] of Object.entries(seed.acls ?? {})) this.acls.set(ref, acl);
    this.principals.push(...(seed.principals ?? []));
    this.groups.push(...(seed.groups ?? []));
    this.activity.push(...(seed.activity ?? []));
  }

  // ── Mutations (what makes delta-sync demonstrable) ─────────────────────

  addDocument(doc: MockDocument): void {
    const kind = this.docs.has(doc.ref) ? 'updated' : 'created';
    this.docs.set(doc.ref, doc);
    this.feed.push({ ref: doc.ref, kind, sourceRevision: doc.revision });
  }

  deleteDocument(ref: string): void {
    this.docs.delete(ref);
    this.feed.push({ ref, kind: 'deleted' });
  }

  updateAcl(ref: string, acl: AclSnapshot): void {
    this.acls.set(ref, acl);
    this.feed.push({ ref, kind: 'acl_changed' });
  }

  recordActivity(event: ActivityEvent): void {
    this.activity.push(event);
  }

  // ── Port factories ─────────────────────────────────────────────────────

  changeFeedPort(): ChangeFeedPort {
    return {
      apiVersion: 'v1',
      probe: async () => ({ ok: true }),
      listChanges: async (_ctx, cursor) => this.pageOf(this.feed, cursor, { tailResumable: true }),
    };
  }

  contentPort(): ContentPort {
    return {
      apiVersion: 'v1',
      probe: async () => ({ ok: true }),
      fetchContent: async (_ctx, ref): Promise<ContentResult> => {
        const doc = this.docs.get(ref);
        if (!doc) throw PortError.permanent(`mock source has no document ${ref}`);
        return { fields: doc.fields, revision: doc.revision };
      },
    };
  }

  aclPort(): AclPort {
    return {
      apiVersion: 'v1',
      probe: async () => ({ ok: true }),
      fetchAcl: async (_ctx, ref): Promise<AclSnapshot> => {
        const acl = this.acls.get(ref);
        if (!acl) throw PortError.permanent(`mock source has no ACL for ${ref}`);
        return acl;
      },
    };
  }

  principalsPort(opts: { includeGroups?: boolean } = {}): PrincipalsPort {
    const port: {
      apiVersion: 'v1';
      probe: PrincipalsPort['probe'];
      listPrincipals: PrincipalsPort['listPrincipals'];
      listGroups?: NonNullable<PrincipalsPort['listGroups']>;
    } = {
      apiVersion: 'v1',
      probe: async () => ({ ok: true }),
      listPrincipals: async (_ctx, cursor) => this.pageOf(this.principals, cursor, {}),
    };
    if (opts.includeGroups ?? this.groups.length > 0) {
      port.listGroups = async (_ctx, cursor) => this.pageOf(this.groups, cursor, {});
    }
    return port;
  }

  activityPort(): ActivityPort {
    return {
      apiVersion: 'v1',
      probe: async () => ({ ok: true }),
      listActivity: async (_ctx, cursor) => this.pageOf(this.activity, cursor, { tailResumable: true }),
    };
  }

  // ── Lifecycle-hook factories ───────────────────────────────────────────

  registerWebhookHook(): (ctx: ConnectorContext) => Promise<void> {
    return async (ctx) => {
      this.webhookRegistrations.add(ctx.tenantConnectorId);
    };
  }

  unregisterWebhookHook(): (ctx: ConnectorContext) => Promise<void> {
    return async (ctx) => {
      this.webhookRegistrations.delete(ctx.tenantConnectorId);
    };
  }

  // ── Paging engine ──────────────────────────────────────────────────────

  private pageOf<T>(
    items: readonly T[],
    cursor: Cursor | null,
    opts: { tailResumable?: boolean },
  ): Page<T> {
    const offset = cursor === null ? 0 : this.decodeCursor(cursor);
    const slice = items.slice(offset, offset + this.pageSize);
    const nextOffset = offset + slice.length;
    if (nextOffset < items.length) {
      return { items: slice, nextCursor: `off:${nextOffset}` };
    }
    // Tail reached. Resumable listings return the tail offset as a
    // standing resume point (the deltaSync signal); snapshot listings end.
    return {
      items: slice,
      nextCursor: opts.tailResumable ? `off:${nextOffset}` : null,
    };
  }

  private decodeCursor(cursor: Cursor): number {
    const m = /^off:(\d+)$/.exec(cursor);
    if (!m) throw PortError.permanent(`mock source got a cursor it never issued: ${cursor}`);
    return Number(m[1]);
  }
}

/** A ConnectorContext for tests/certification — no real tenant behind it. */
export function makeMockContext(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    tenantId: '00000000-0000-0000-0000-000000000001',
    tenantConnectorId: '00000000-0000-0000-0000-0000000000c1',
    credentials: {},
    now: () => new Date('2026-07-11T00:00:00Z'),
    ...overrides,
  };
}
