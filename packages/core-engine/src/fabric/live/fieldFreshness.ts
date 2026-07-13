/**
 * ADR-008 contract predicates — field-level freshness, as pure functions.
 *
 * Freshness is a PER-FIELD property that selects a retrieval strategy; it is
 * NEVER a versioning concept (ADR-003 owns revisioning). The stricter of the
 * two freshness systems (manifest field class vs tenant SLA) always wins —
 * a tenant SLA can only TIGHTEN a field, never loosen it below its declared
 * class. Ships green at ADR-008 ratification; the K.6 live path consumes it.
 */

import { DEFAULT_STALENESS_BOUNDS_MS, type FreshnessClass } from '../permissions/contract.js';

export type { FreshnessClass };

/** The class lattice (§5.2): static < operational < transactional < critical. */
export const FRESHNESS_LATTICE: readonly FreshnessClass[] = [
  'static', 'operational', 'transactional', 'critical',
];

/** Undeclared fields default to `operational` — NEVER `static` (§3.1: fail-safe, not fail-open). */
export const DEFAULT_FIELD_CLASS: FreshnessClass = 'operational';

function rank(c: FreshnessClass): number {
  return FRESHNESS_LATTICE.indexOf(c);
}

/**
 * Stricter-wins (§3.2): the effective class is the higher-lattice of the
 * manifest class and the tenant SLA class (absent ⇒ no constraint). Total,
 * order-independent, and monotonic — the result is ALWAYS ≥ the manifest
 * class (a tenant SLA can only tighten).
 */
export function resolveFieldFreshness(
  manifestClass: FreshnessClass,
  slaClass?: FreshnessClass,
): FreshnessClass {
  if (slaClass === undefined) return manifestClass;
  return rank(slaClass) > rank(manifestClass) ? slaClass : manifestClass;
}

/**
 * Per-class live-read strategy (§3.3 / §5.2 "Default Strategy"):
 *  - static:        never live (index only; bound is days–weeks)
 *  - operational:   live only when the indexed copy is stale (age > bound)
 *  - transactional: live-preferred — the seconds-bound makes index unreliable
 *  - critical:      always live (bound 0 — index is never trusted)
 */
type LiveStrategy = 'never' | 'when_stale' | 'always';
const LIVE_STRATEGY: Readonly<Record<FreshnessClass, LiveStrategy>> = {
  static: 'never',
  operational: 'when_stale',
  transactional: 'always',
  critical: 'always',
};

export interface FieldFreshness {
  readonly field: string;
  readonly effectiveClass: FreshnessClass;
  /** Age of the indexed copy of this field, ms. */
  readonly indexAgeMs: number;
}

/**
 * The subset of fields whose retrieval path is LIVE (§3.3). Critical and
 * transactional are always live; operational is live only when stale; static
 * never. The planner fetches ONLY these live (§5.1) — the majority stay
 * index-served.
 */
export function fieldsRequiringLive(
  fields: readonly FieldFreshness[],
  bounds: Readonly<Record<FreshnessClass, number>> = DEFAULT_STALENESS_BOUNDS_MS,
): string[] {
  return fields
    .filter((f) => {
      const strat = LIVE_STRATEGY[f.effectiveClass];
      if (strat === 'always') return true;
      if (strat === 'never') return false;
      return f.indexAgeMs > bounds[f.effectiveClass]; // when_stale
    })
    .map((f) => f.field);
}

/**
 * Document-worst-class (§3.5): a document is as fresh-sensitive as its most
 * sensitive field — the storage gate (ADR-010 decideServing) uses this to
 * decide withholding at document granularity.
 */
export function worstFieldClass(classes: readonly FreshnessClass[]): FreshnessClass {
  let worst: FreshnessClass = 'static';
  for (const c of classes) if (rank(c) > rank(worst)) worst = c;
  return worst;
}

export interface MultiPathComposition {
  readonly fields: Readonly<Record<string, unknown>>;
  /** Per-field: which path served it (provenance substrate, ADR-007). */
  readonly fieldPaths: Readonly<Record<string, 'index' | 'live'>>;
}

/**
 * Field-disjoint multi-path composition (§3.4): merge index-served and
 * live-served fields into one object BEFORE it reaches the agent. Each field
 * has exactly ONE source in the result (live wins where present) — there is
 * never a field-level "which value wins" merge (that is ADR-003's
 * document-revision conflict path, not this). Records the per-field path.
 */
export function composeMultiPath(
  indexFields: Readonly<Record<string, unknown>>,
  liveFields: Readonly<Record<string, unknown>>,
): MultiPathComposition {
  const fields: Record<string, unknown> = {};
  const fieldPaths: Record<string, 'index' | 'live'> = {};
  for (const [k, v] of Object.entries(indexFields)) {
    fields[k] = v;
    fieldPaths[k] = 'index';
  }
  for (const [k, v] of Object.entries(liveFields)) {
    fields[k] = v; // live is field-disjoint authority — overrides the index copy
    fieldPaths[k] = 'live';
  }
  return { fields, fieldPaths };
}
