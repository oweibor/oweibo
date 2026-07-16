/**
 * K.1 — ActivityPort: the ranking-signal face. Streams view/edit/share
 * events so retrieval can rank by liveness (arch §7).
 *
 * Failure mapping (§11.7): ANY activity failure is recomputable — the
 * signal is derived, loss degrades ranking quality but never correctness.
 * Activity jobs are class-5 sheddable (ADR-013); adapters still classify
 * errors normally (transient/permanent/partial), and the runtime treats
 * the whole port as safe to shed under load.
 */
import type { ConnectorContext } from '../context.js';
import type { Cursor, Page, PortBase } from './types.js';

export interface ActivityEvent {
  /** Object the activity happened on (ChangeFeed ref namespace). */
  readonly ref: string;
  readonly kind: 'view' | 'edit' | 'share' | 'comment' | 'other';
  /** Source principal who acted, when the source exposes it. */
  readonly principal?: string;
  /** ISO-8601 occurrence time. */
  readonly occurredAt: string;
}

export interface ActivityPort extends PortBase<ConnectorContext> {
  listActivity(ctx: ConnectorContext, cursor: Cursor | null): Promise<Page<ActivityEvent>>;
}
