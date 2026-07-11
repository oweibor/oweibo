/**
 * ADR-010 §3.3 — evaluation-time transitive group closure over raw
 * membership edges, as executable contract.
 *
 * The stored representation is ALWAYS the raw edge (kf_membership_records,
 * schema chapter): `principal_ref belongs-to group_ref`, where groups may
 * themselves appear as principal_ref in other rows — that is how nesting
 * is represented. Flattening happens here, at evaluation time, bounded and
 * cycle-safe; materializing closures into storage is a rejected
 * alternative (a source re-org would rewrite the world).
 *
 * Truncation contract: hitting the depth bound neither errors nor
 * silently narrows the audience decision — the result carries
 * `truncated: true`, and a truncated closure forces live ACL validation
 * for that check (the same degradation lane as connectors without group
 * sync, §10.2).
 */

export interface MembershipEdge {
  /** The member — a user principal or a nested group. */
  readonly principalRef: string;
  /** The group it belongs to. */
  readonly groupRef: string;
}

export interface GroupClosureResult {
  /** Every group the principal transitively belongs to. */
  readonly groups: ReadonlySet<string>;
  /** Depth bound was hit — caller MUST degrade to live validation. */
  readonly truncated: boolean;
}

/** ADR-010 §6 default (Expected to evolve — ops-tunable). */
export const DEFAULT_CLOSURE_DEPTH = 20;

/**
 * Compute the set of groups `startPrincipal` transitively belongs to.
 * Cycle-safe (a group already expanded is never expanded again — cyclic
 * directory data is tolerated, not an error); depth-bounded (depth 1 =
 * direct memberships).
 */
export function computeGroupClosure(
  edges: readonly MembershipEdge[],
  startPrincipal: string,
  opts: { readonly maxDepth?: number } = {},
): GroupClosureResult {
  const maxDepth = opts.maxDepth ?? DEFAULT_CLOSURE_DEPTH;
  // member → its direct groups
  const directGroups = new Map<string, string[]>();
  for (const e of edges) {
    const list = directGroups.get(e.principalRef);
    if (list) list.push(e.groupRef);
    else directGroups.set(e.principalRef, [e.groupRef]);
  }

  const groups = new Set<string>();
  let frontier = [startPrincipal];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const member of frontier) {
      for (const g of directGroups.get(member) ?? []) {
        if (!groups.has(g)) {
          groups.add(g);
          next.push(g); // the group may itself be a member of further groups
        }
      }
    }
    frontier = next;
  }

  // Truncated iff groups discovered AT the bound still have unexpanded
  // outgoing edges to groups we haven't seen — reaching the bound with a
  // frontier of leaf groups is a COMPLETE closure, not a truncated one.
  const truncated = frontier.some((g) =>
    (directGroups.get(g) ?? []).some((next) => !groups.has(next)),
  );

  return { groups, truncated };
}

/**
 * §3.4 audience check (within-source, pre-K.8): the user is in the
 * audience iff their own principal ref, or any group in their closure,
 * appears in the ACL grant set. Cross-source canonical evaluation is
 * ADR-002 (K.8); nothing here grows toward it.
 */
export function isInAudience(
  grantRefs: ReadonlySet<string> | readonly string[],
  principalRef: string,
  closure: GroupClosureResult,
): boolean {
  const grants = grantRefs instanceof Set ? grantRefs : new Set(grantRefs);
  if (grants.has(principalRef)) return true;
  for (const g of closure.groups) {
    if (grants.has(g)) return true;
  }
  return false;
}
