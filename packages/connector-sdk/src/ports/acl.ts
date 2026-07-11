/**
 * K.1 — AclPort: the governance snapshot face. Fetches who may see an
 * object, as the *source* believes it, so retrieval can enforce
 * source-consistent visibility (arch §6).
 *
 * Failure mapping (§11.7): the canonical *partial* example — the ACL API
 * can be down while the content API is healthy; throwing
 * PortError.partial keeps content indexing alive while visibility
 * updates pause (fail-closed: objects with a stale ACL snapshot are
 * served under the stale — more restrictive when in doubt — snapshot,
 * never under a guessed one).
 */
import type { ConnectorContext } from '../context.js';
import type { PortBase } from './types.js';

export interface AclPrincipalGrant {
  /** Principal identifier in the source's namespace (user or group). */
  readonly principal: string;
  readonly kind: 'user' | 'group';
  readonly access: 'read' | 'write' | 'owner';
}

export interface AclSnapshot {
  /**
   * Version token for this ACL state. Snapshot hashing (§6.2) is a
   * convention the SDK provides — the adapter only reports the source's
   * own version when it has one, or a content hash of the grants.
   */
  readonly aclVersion: string;
  readonly principals: readonly AclPrincipalGrant[];
}

export interface AclPort extends PortBase<ConnectorContext> {
  /** Fetch the current ACL of one object. */
  fetchAcl(ctx: ConnectorContext, ref: string): Promise<AclSnapshot>;
}
