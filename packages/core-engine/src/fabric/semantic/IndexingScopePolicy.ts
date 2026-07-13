/**
 * K.5 — Indexing Scope policy (arch §4.5, §18.2). Full-content embedding is
 * TENANT OPT-IN: the default is metadata-only (what K.3 already indexes), and
 * a tenant raises the scope to `full_content` through its policy to enable the
 * semantic layer. The policy *content* is ADR-006's (tenant policy system);
 * K.5 owns only this gate and its default.
 *
 * Why opt-in: full-content embedding copies document bodies into the vector
 * store — a data-residency and cost decision a tenant makes deliberately, not
 * a platform default (§10.4's "default-off is a budget decision" logic
 * applied to indexing depth).
 */

export type IndexingScope = 'metadata' | 'full_content';

/** Default when a tenant has set no explicit scope — metadata only (K.3 behavior). */
export const DEFAULT_INDEXING_SCOPE: IndexingScope = 'metadata';

/** Whether the semantic (embedding) layer runs for a tenant at the given scope. */
export function shouldEmbed(scope: IndexingScope = DEFAULT_INDEXING_SCOPE): boolean {
  return scope === 'full_content';
}
