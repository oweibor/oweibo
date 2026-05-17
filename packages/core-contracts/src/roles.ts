// DONE: Phase A.10 — canonical CanonicalRole enum + const array
// Single authoritative source for the 4 roles the prompt registry serves.
// All other code must import from here; string literals are banned by CI gate.

/**
 * CanonicalRole — the four roles that CohortRouter resolves prompt versions for.
 * A subset of the wider AgentRole union in AgentTypes.ts.
 */
export type CanonicalRole = 'architect' | 'executor' | 'reviewer' | 'decomposer';

/**
 * CANONICAL_ROLES — immutable ordered list of all canonical roles.
 * Iterate over this instead of hardcoding string literals.
 */
export const CANONICAL_ROLES: readonly CanonicalRole[] = [
  'architect',
  'executor',
  'reviewer',
  'decomposer',
] as const;
