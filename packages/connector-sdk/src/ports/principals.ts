/**
 * K.1 — PrincipalsPort: the identity face (IdP). Lists the users and
 * groups of the source so ACL grants resolve to platform principals
 * (identity ground truth before any content connector — P11, §9.5).
 *
 * Group nesting: `listGroups` pages carry each group's direct member
 * groups (`memberGroups`); the platform runtime computes transitive
 * closure — adapters never flatten nesting themselves (sources disagree
 * on depth limits, and the closure must be recomputed platform-side when
 * any edge changes anyway).
 *
 * Failure mapping (§11.7): as ChangeFeed — 5xx → transient, revoked
 * directory scope → permanent, directory API down while content is up →
 * partial.
 */
import type { ConnectorContext } from '../context.js';
import type { Cursor, Page, PortBase } from './types.js';

export interface SourcePrincipal {
  /** Source-native stable id. */
  readonly id: string;
  /** Email or unique login usable for cross-source identity resolution. */
  readonly email?: string;
  readonly displayName?: string;
  readonly status: 'active' | 'suspended' | 'deleted';
}

export interface SourceGroup {
  readonly id: string;
  readonly displayName?: string;
  /** Direct user members (source-native principal ids). */
  readonly memberPrincipals: readonly string[];
  /** Direct member *groups* — nesting edges; closure is platform-side. */
  readonly memberGroups: readonly string[];
}

export interface PrincipalsPort extends PortBase<ConnectorContext> {
  listPrincipals(ctx: ConnectorContext, cursor: Cursor | null): Promise<Page<SourcePrincipal>>;
  /**
   * Optional: sources without a group model omit it. Implementing this
   * is what demonstrates the `groups` supports-flag (INV-15).
   */
  listGroups?(ctx: ConnectorContext, cursor: Cursor | null): Promise<Page<SourceGroup>>;
}
