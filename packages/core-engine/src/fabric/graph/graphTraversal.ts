/**
 * ADR-002 §3.6 contract predicates — knowledge-graph traversal + proximity,
 * as pure functions. Traversal is BFS, cycle-safe, depth-bounded (the
 * computeGroupClosure discipline). Graph proximity is a decreasing function
 * of shortest-path length over ACTIVE edges only — it plugs into the K.5
 * hybridRank `graphProximity` slot. Pending/retracted edges never contribute.
 */

export type EdgeState = 'active' | 'pending' | 'retracted';
export type EdgeConfidence = 'resolved' | 'provisional';

/** A directed graph edge (structural mirror of a kf_graph_edges row). */
export interface GraphEdge {
  readonly srcRef: string;
  readonly dstRef: string;
  readonly edgeType: string;
  readonly state: EdgeState;
  readonly confidence: EdgeConfidence;
}

/** Default BFS depth bound — cycle-safe traversal never exceeds it (mirrors group-closure depth 20). */
export const DEFAULT_TRAVERSAL_DEPTH = 20;

interface AdjacencyResult {
  /** Node ref → shortest active-edge distance from the start. */
  readonly distances: ReadonlyMap<string, number>;
  /** True when the depth bound truncated a still-expanding frontier. */
  readonly truncated: boolean;
}

/**
 * BFS over ACTIVE edges from `start`, bounded at `maxDepth`. Cycle-safe (a
 * visited node is never re-expanded). `truncated` is true iff a node AT the
 * bound still had unexplored active neighbours — the honest "closure may be
 * incomplete" signal (same rule as computeGroupClosure).
 */
export function traverse(
  edges: readonly GraphEdge[],
  start: string,
  maxDepth: number = DEFAULT_TRAVERSAL_DEPTH,
): AdjacencyResult {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.state !== 'active') continue; // pending/retracted never traversed
    const list = adj.get(e.srcRef);
    if (list) list.push(e.dstRef);
    else adj.set(e.srcRef, [e.dstRef]);
  }

  const distances = new Map<string, number>([[start, 0]]);
  let frontier = [start];
  let depth = 0;
  let truncated = false;

  while (frontier.length > 0 && depth < maxDepth) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const nbr of adj.get(node) ?? []) {
        if (!distances.has(nbr)) {
          distances.set(nbr, depth + 1);
          next.push(nbr);
        }
      }
    }
    frontier = next;
    depth += 1;
  }
  // If a node still sits at the bound with an unexpanded neighbour, the closure is incomplete.
  if (frontier.length > 0) {
    truncated = frontier.some((n) => (adj.get(n) ?? []).some((nbr) => !distances.has(nbr)));
  }

  return { distances, truncated };
}

/**
 * Shortest-path length from `a` to `b` over active edges, or null if
 * unreachable within the depth bound.
 */
export function shortestPathLen(
  edges: readonly GraphEdge[],
  a: string,
  b: string,
  maxDepth: number = DEFAULT_TRAVERSAL_DEPTH,
): number | null {
  if (a === b) return 0;
  const { distances } = traverse(edges, a, maxDepth);
  return distances.get(b) ?? null;
}

/**
 * Graph proximity in [0,1] for the hybridRank signal (§3.6): 1/(1+dist) over
 * shortest active path; 0 when unreachable. Directly adjacent = 0.5, two hops
 * ≈ 0.33, self = 1. Pending/retracted edges never contribute (they are not
 * `active`), so a retracted merge stops boosting the moment it is retracted.
 */
export function graphProximity(
  edges: readonly GraphEdge[],
  a: string,
  b: string,
  maxDepth: number = DEFAULT_TRAVERSAL_DEPTH,
): number {
  const dist = shortestPathLen(edges, a, b, maxDepth);
  return dist === null ? 0 : 1 / (1 + dist);
}

/**
 * The neighbours of `node` by edge type (e.g. all `owns` targets) over active
 * edges — the primitive behind a "who owns X?" graph answer.
 */
export function neighborsByType(
  edges: readonly GraphEdge[],
  node: string,
  edgeType: string,
  direction: 'out' | 'in' = 'out',
): string[] {
  const out: string[] = [];
  for (const e of edges) {
    if (e.state !== 'active' || e.edgeType !== edgeType) continue;
    if (direction === 'out' && e.srcRef === node) out.push(e.dstRef);
    if (direction === 'in' && e.dstRef === node) out.push(e.srcRef);
  }
  return out;
}
