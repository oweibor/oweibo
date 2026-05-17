/**
 * CanonicalRole — the four roles that CohortRouter resolves prompt versions for.
 * A subset of the wider AgentRole union in AgentTypes.ts.
 */
export type CanonicalRole = 'architect' | 'executor' | 'reviewer' | 'decomposer';
/**
 * CANONICAL_ROLES — immutable ordered list of all canonical roles.
 * Iterate over this instead of hardcoding string literals.
 */
export declare const CANONICAL_ROLES: readonly CanonicalRole[];
//# sourceMappingURL=roles.d.ts.map