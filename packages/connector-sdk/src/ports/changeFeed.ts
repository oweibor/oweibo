/**
 * K.1 — ChangeFeedPort: the discovery face (Glean). Tells the platform
 * *what changed* in the source so indexing jobs can be scheduled; it does
 * NOT carry content (that is ContentPort's job — a change event is a
 * pointer, not a payload).
 *
 * Failure mapping (§11.7): source 5xx / rate-limit → transient; revoked
 * grant → permanent; feed endpoint down while content API is up → partial.
 *
 * Delta-sync semantics: a feed that returns a non-null `nextCursor` on its
 * final (possibly empty) page is resumable — the platform persists that
 * tail cursor and polls later, receiving only changes since. A feed that
 * ends with `nextCursor: null` is snapshot-only; declaring `deltaSync` in
 * `supports{}` with a snapshot-only feed fails certification (INV-15).
 */
import type { ConnectorContext } from '../context.js';
import type { Cursor, Page, PortBase } from './types.js';

/** A pointer to a changed object — never the object's content. */
export interface ChangeEvent {
  /** Source-native stable object identifier. */
  readonly ref: string;
  readonly kind: 'created' | 'updated' | 'deleted' | 'acl_changed';
  /** Source revision at the time of the change, when the source exposes one. */
  readonly sourceRevision?: string;
  /** Source-native occurrence time (ISO-8601), when available. */
  readonly occurredAt?: string;
}

export interface ChangeFeedPort extends PortBase<ConnectorContext> {
  /**
   * List changes since `cursor` (null = from the beginning / initial
   * crawl). Bounded batch; opaque resume token. See Page<T> for the
   * tail-cursor delta-sync contract.
   */
  listChanges(ctx: ConnectorContext, cursor: Cursor | null): Promise<Page<ChangeEvent>>;
}
