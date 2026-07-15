/**
 * ADR-006 §3.1–§3.3 — the tenant policy contract: dimensions, their fixed
 * category, and the relaxation lattice.
 *
 * The load-bearing rule (ADR-006 §1): a policy change is a RELAXATION unless
 * it is PROVABLY a tightening. Incomparable changes take the safe branch,
 * because the ambiguous case is the dangerous case — swapping excluded tags
 * from {HR} to {Legal} is neither tighter nor looser, and it unprotects HR.
 *
 * Category is a property of the DIMENSION, never of the row (§3.1): an admin
 * must not be able to re-declare data_residency as operational and thereby
 * demote it from storage-layer enforcement (INV-4) to a planner hint.
 */

// ── Dimensions ───────────────────────────────────────────────────────────

export type PolicyCategory = 'compliance' | 'operational';

export type PolicyDimension =
  | 'data_persistence'
  | 'indexing_scope'
  | 'connector_enablement'
  | 'operation_permissions'
  | 'data_residency'
  | 'classification_exclusions'
  | 'freshness_sla'
  | 'retrieval_preference';

/**
 * ADR-006 §3.1 — the fixed dimension→category map. Total over
 * PolicyDimension; a new dimension without a row here fails to compile.
 *
 * connector_enablement is COMPLIANCE, not operational: §18.2 says a disabled
 * connector "is absent, not merely deprioritized" — and "deprioritized" is
 * exactly what operational (planner-input) enforcement would give.
 */
export const DIMENSION_CATEGORY: Readonly<Record<PolicyDimension, PolicyCategory>> = {
  data_persistence:         'compliance',
  indexing_scope:           'compliance',
  connector_enablement:     'compliance',
  operation_permissions:    'compliance',
  data_residency:           'compliance',
  classification_exclusions:'compliance',
  freshness_sla:            'operational',
  retrieval_preference:     'operational',
};

export const POLICY_DIMENSIONS: readonly PolicyDimension[] = Object.keys(
  DIMENSION_CATEGORY,
) as PolicyDimension[];

export function categoryOf(dimension: PolicyDimension): PolicyCategory {
  return DIMENSION_CATEGORY[dimension];
}

export function isCompliance(dimension: PolicyDimension): boolean {
  return DIMENSION_CATEGORY[dimension] === 'compliance';
}

// ── Values ───────────────────────────────────────────────────────────────

export type IndexingScope = 'metadata' | 'full_content';

export type PolicyValue =
  | { readonly kind: 'data_persistence'; readonly allowed: boolean }
  | { readonly kind: 'indexing_scope'; readonly scope: IndexingScope }
  | { readonly kind: 'connector_enablement'; readonly enabled: Readonly<Record<string, boolean>> }
  | { readonly kind: 'operation_permissions'; readonly liveRead: boolean; readonly liveWrite: boolean }
  | { readonly kind: 'data_residency'; readonly region: string }
  | { readonly kind: 'classification_exclusions'; readonly excludeTags: readonly string[] }
  | { readonly kind: 'freshness_sla'; readonly maxAgeMs: Readonly<Record<string, number>> }
  | { readonly kind: 'retrieval_preference'; readonly mode: Readonly<Record<string, 'index' | 'live' | 'hybrid'>> };

/** ADR-006 §3.1 defaults. `indexing_scope: metadata` preserves K.5 behavior exactly. */
export const POLICY_DEFAULTS: { readonly [K in PolicyDimension]: Extract<PolicyValue, { kind: K }> } = {
  data_persistence:          { kind: 'data_persistence', allowed: true },
  indexing_scope:            { kind: 'indexing_scope', scope: 'metadata' },
  connector_enablement:      { kind: 'connector_enablement', enabled: {} },
  operation_permissions:     { kind: 'operation_permissions', liveRead: true, liveWrite: false },
  data_residency:            { kind: 'data_residency', region: '' },
  classification_exclusions: { kind: 'classification_exclusions', excludeTags: [] },
  freshness_sla:             { kind: 'freshness_sla', maxAgeMs: {} },
  retrieval_preference:      { kind: 'retrieval_preference', mode: {} },
};

// ── The relaxation lattice (§3.3) ────────────────────────────────────────

export type ChangeClass = 'no_change' | 'tightening' | 'relaxation';

/** Key-order-insensitive canonical form, so `{a,b}` and `{b,a}` compare equal. */
const canonical = (o: Readonly<Record<string, unknown>>): string =>
  JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));

/** a ⊑ b — "a is at least as restrictive as b". False when incomparable. */
function atLeastAsRestrictive(a: PolicyValue, b: PolicyValue): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'data_persistence':
      // false ⊑ true — not persisting is more restrictive.
      return !a.allowed || (b as typeof a).allowed;
    case 'indexing_scope':
      // metadata ⊑ full_content.
      return a.scope === 'metadata' || (b as typeof a).scope === 'full_content';
    case 'connector_enablement': {
      // Product order: a ⊑ b iff EVERY connector is ⊑. A connector absent from a
      // map is treated as disabled (the more restrictive reading) so that
      // *adding* a disabled key is never mistaken for a relaxation.
      const bv = (b as typeof a).enabled;
      const keys = new Set([...Object.keys(a.enabled), ...Object.keys(bv)]);
      for (const k of keys) {
        const av = a.enabled[k] ?? false;
        const bb = bv[k] ?? false;
        if (av && !bb) return false; // a enables something b does not ⇒ a is looser
      }
      return true;
    }
    case 'operation_permissions': {
      const bo = b as typeof a;
      return (!a.liveRead || bo.liveRead) && (!a.liveWrite || bo.liveWrite);
    }
    case 'data_residency':
      // INCOMPARABLE for any region change (§3.3): the platform MUST NOT encode
      // a legal ranking of regions. Only identity is ⊑.
      return a.region === (b as typeof a).region;
    case 'classification_exclusions': {
      // Superset ⊑ subset — excluding MORE tags is more restrictive.
      const bt = new Set((b as typeof a).excludeTags);
      for (const t of bt) if (!a.excludeTags.includes(t)) return false;
      return true;
    }
    case 'freshness_sla': {
      // Operational, but still ordered: a SMALLER max age is stricter. A key
      // absent from `a` is unbounded ⇒ not stricter.
      const bm = (b as typeof a).maxAgeMs;
      for (const k of Object.keys(bm)) {
        const av = a.maxAgeMs[k];
        if (av === undefined || av > bm[k]!) return false;
      }
      return true;
    }
    case 'retrieval_preference':
      // No defensible order over path preferences — always incomparable unless equal.
      return canonical(a.mode) === canonical((b as typeof a).mode);
  }
}

/**
 * Equality IS the lattice's antisymmetry: a == b iff a ⊑ b and b ⊑ a.
 *
 * Defining it this way (rather than by structural/JSON comparison) keeps
 * equality and ordering from ever disagreeing. That matters concretely: §3.3
 * reads an absent connector key as *disabled*, so `{}` and `{github: false}`
 * denote the same policy. A JSON comparison would call that pair "different",
 * classify a semantic no-op as a tightening, and trigger a mandatory backfill
 * over the tenant's whole index (§3.5) for a change that means nothing.
 */
function valuesEqual(a: PolicyValue, b: PolicyValue): boolean {
  if (a.kind !== b.kind) return false;
  return atLeastAsRestrictive(a, b) && atLeastAsRestrictive(b, a);
}

/**
 * ADR-006 §3.3 — classify ONE dimension's change.
 *
 *   new == old            -> no_change
 *   provably new ⊑ old    -> tightening
 *   otherwise             -> relaxation   (incomparable included — fail-closed)
 */
export function classifyChange(oldValue: PolicyValue, newValue: PolicyValue): ChangeClass {
  if (valuesEqual(oldValue, newValue)) return 'no_change';
  if (atLeastAsRestrictive(newValue, oldValue)) return 'tightening';
  return 'relaxation';
}

/**
 * ADR-006 §3.3 — classify a MIXED change. If ANY component is a relaxation the
 * whole change is a relaxation: bundling must not launder a relaxation through
 * a tightening ("tighten indexing_scope and incidentally move region").
 */
export function classifyChangeSet(
  changes: readonly { readonly oldValue: PolicyValue; readonly newValue: PolicyValue }[],
): ChangeClass {
  let sawTightening = false;
  for (const c of changes) {
    const k = classifyChange(c.oldValue, c.newValue);
    if (k === 'relaxation') return 'relaxation';
    if (k === 'tightening') sawTightening = true;
  }
  return sawTightening ? 'tightening' : 'no_change';
}

/** ADR-006 §3.4 — relaxations require dual control; tightenings do not. */
export function requiresDualControl(cls: ChangeClass): boolean {
  return cls === 'relaxation';
}

/** ADR-006 §3.5 — a tightening's backfill is mandatory (§18.5), not best-effort. */
export function requiresBackfill(cls: ChangeClass): boolean {
  return cls === 'tightening';
}

// ── Dual-control floor (§3.4) ────────────────────────────────────────────

/** The reserved action class a compliance relaxation flows through. */
export const POLICY_RELAXATION_ACTION_CLASS = 'governance.policy_relaxation';

/**
 * ADR-006 §3.4 / §6 — the PLATFORM floor for the reserved class. Not a tenant
 * default: the control exists to defend against a tenant admin (§22), so its
 * adversary must not be able to configure it.
 *
 * allowGrants=false is the subtle one: a time-windowed grant is PRE-approval,
 * and pre-approved dual control is single control with extra steps. The shipped
 * multi_party_approval_policies defaults allow_delegation=true, which would let
 * one admin hold both votes — hence both are pinned false here.
 */
export const POLICY_RELAXATION_FLOOR = {
  quorum: 2,
  allowGrants: false,
  allowDelegation: false,
  dissentVetoes: true,
} as const;

export interface RelaxationVote {
  readonly principalId: string;
  readonly approve: boolean;
}

export type QuorumVerdict =
  | { readonly kind: 'approved'; readonly approvers: readonly string[] }
  | { readonly kind: 'vetoed'; readonly by: string }
  | { readonly kind: 'pending'; readonly have: number; readonly need: number };

/**
 * ADR-006 §3.4 rule 3 — quorum is over DISTINCT principals, and the proposer
 * counts as at most one of them. With quorum=2 this yields exactly §22's "a
 * second authorized approver": proposer + 1 independent approver.
 *
 * Deliberately NOT "the proposer's vote does not count", which would demand two
 * independent approvers (three people) — more than §22 mandates, with no extra
 * protection against the single-admin threat it names.
 */
export function evaluateQuorum(
  proposerId: string,
  votes: readonly RelaxationVote[],
  quorum: number = POLICY_RELAXATION_FLOOR.quorum,
): QuorumVerdict {
  // Distinct principals only — one principal voting twice is one vote (§3.4).
  const seen = new Map<string, boolean>();
  for (const v of votes) {
    if (!seen.has(v.principalId)) seen.set(v.principalId, v.approve);
  }
  for (const [principalId, approve] of seen) {
    if (!approve) return { kind: 'vetoed', by: principalId };
  }
  const approvers = [...seen.keys()];
  const independent = approvers.filter((p) => p !== proposerId);
  // Always at least one approver distinct from the proposer, AND quorum distinct
  // principals overall. The proposer alone can never satisfy this.
  if (approvers.length >= quorum && independent.length >= 1) {
    return { kind: 'approved', approvers };
  }
  return { kind: 'pending', have: approvers.length, need: quorum };
}
