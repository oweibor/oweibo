/**
 * K.1 — ContentPort: the indexing face (Glean). Fetches the content of a
 * single object the ChangeFeedPort pointed at.
 *
 * Failure mapping (§11.7): 5xx / timeout → transient; object deleted or
 * grant revoked → permanent; a payload the adapter cannot parse →
 * corrupt_poison (quarantine that ref; never retry the same input as if
 * time would fix it).
 */
import type { ConnectorContext } from '../context.js';
import type { PortBase } from './types.js';

export interface ContentResult {
  /**
   * Field name → extracted value. Field names line up with the
   * connector's `freshnessClasses` assignments; nested structure is
   * source-private and must already be flattened to indexable fields.
   */
  readonly fields: Readonly<Record<string, unknown>>;
  /**
   * Source revision this content corresponds to. Paired with the
   * document id it forms the idempotency key for indexing jobs
   * (ADR-013 — duplicate (ref, revision) is a no-op).
   */
  readonly revision: string;
}

export interface ContentPort extends PortBase<ConnectorContext> {
  /** Fetch the content of one object by the ref a ChangeEvent carried. */
  fetchContent(ctx: ConnectorContext, ref: string): Promise<ContentResult>;
}
