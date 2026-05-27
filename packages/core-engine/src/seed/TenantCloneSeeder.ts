/**
 * T.9: TenantCloneSeeder — clones an opt-in subset of a parent tenant's
 * content into a freshly-created child tenant.
 *
 * The seeder is deliberately *interface-based* and shipped with default
 * no-op implementations: the worker process doesn't depend on Qdrant,
 * Redis, or any heavy infra to be construct-able. Operators wire concrete
 * implementations (HTTP client to core-engine, direct orchestrator, etc.)
 * once the platform-side endpoints exist. With every interface left as
 * default the step reports each scope as 'skipped' and the bootstrap
 * proceeds — byte-identical to today for tenants without lineage.
 *
 * Scopes (declared in `tenant_lineage.cloned_scopes`):
 *   - `memories`            — copy parent's `parent:cloneable`-tagged organic
 *                             memories; importance × 0.7 so child's own
 *                             organic memories outrank after divergence.
 *   - `projects`            — copy parent's projects (names prefixed
 *                             `[from parent]`) and their invariant maps.
 *   - `org_graph`           — copy parent's org nodes + edges.
 *                             `person` nodes are cloned as SHELL nodes:
 *                             label preserved, `user_id` set to NULL.
 *                             This preserves the team's `member_of`
 *                             edge structure (FK invariant) so cloning
 *                             `team` nodes doesn't produce dangling FKs.
 *                             Shell person nodes appear in the child
 *                             tenant's "review needed" admin list; they
 *                             rebind to real users when those users
 *                             accept invitations (T.2.h alignment).
 *                             Audit-fix (T.9): the alternative — skipping
 *                             person nodes — broke FK invariants because
 *                             team→member_of→person edges in the parent
 *                             would FK-violate when re-inserted in the
 *                             child without the destination node.
 *   - `connectors_recommend` — write recommendations for parent's installed
 *                             connector types; credentials NEVER transfer.
 *   - `settings`            — copy `trustModeDefault`, cohort_channel,
 *                             home_region, and an explicit features subset.
 *
 * Importance multiplier on cloned memories
 * ─────────────────────────────────────────
 * 0.7× is a deliberate choice: a child's own organic memory at importance
 * 0.5 should out-rank a parent-cloned memory at importance 0.7×0.7=0.49.
 * Tuneable; surfaced as a constant rather than hard-coded into the
 * recall scorer so the rationale is co-located with the clone path.
 */
export const CLONED_MEMORY_IMPORTANCE_MULTIPLIER = 0.7;

export type CloneScope =
  | 'memories'
  | 'projects'
  | 'org_graph'
  | 'connectors_recommend'
  | 'settings';

export interface CloneRequest {
  readonly parentTenantId: string;
  readonly childTenantId: string;
  readonly scopes: readonly CloneScope[];
}

export interface CloneScopeResult {
  readonly scope: CloneScope;
  readonly status: 'ok' | 'skipped' | 'failed';
  /** Number of items copied (memories / projects / nodes / etc.). */
  readonly copied?: number;
  readonly error?: string;
}

export interface CloneSummary {
  readonly results: readonly CloneScopeResult[];
}

/**
 * Concrete copy operations the seeder needs from infrastructure. Each is
 * optional — when absent the corresponding scope reports 'skipped'.
 */
export interface CloneInfra {
  /** Copy `parent:cloneable`-tagged memories from parent collection to child. */
  copyMemories?(parentTenantId: string, childTenantId: string): Promise<number>;
  copyProjects?(parentTenantId: string, childTenantId: string): Promise<number>;
  copyOrgGraph?(parentTenantId: string, childTenantId: string): Promise<number>;
  recommendConnectors?(parentTenantId: string, childTenantId: string): Promise<number>;
  copySettings?(parentTenantId: string, childTenantId: string): Promise<number>;
  /** Optional audit sink — invoked once per scope with status + count. */
  audit?(row: CloneAuditRow): Promise<void>;
}

export interface CloneAuditRow {
  readonly action: `tenant.lineage.clone.${CloneScope}`;
  readonly details: {
    readonly parent_tenant_id: string;
    readonly child_tenant_id: string;
    readonly status: CloneScopeResult['status'];
    readonly copied?: number;
    readonly error?: string;
  };
}

export class TenantCloneSeeder {
  constructor(private readonly infra: CloneInfra = {}) {}

  async clone(req: CloneRequest): Promise<CloneSummary> {
    const results: CloneScopeResult[] = [];
    for (const scope of req.scopes) {
      const result = await this.cloneOne(req.parentTenantId, req.childTenantId, scope);
      results.push(result);
      // Fire-and-forget audit. Failures here must never block the clone.
      void this.infra.audit?.({
        action: `tenant.lineage.clone.${scope}` as const,
        details: {
          parent_tenant_id: req.parentTenantId,
          child_tenant_id: req.childTenantId,
          status: result.status,
          ...(result.copied !== undefined ? { copied: result.copied } : {}),
          ...(result.error ? { error: result.error } : {}),
        },
      }).catch(() => undefined);
    }
    return { results };
  }

  private async cloneOne(
    parent: string,
    child: string,
    scope: CloneScope,
  ): Promise<CloneScopeResult> {
    const op = this.opFor(scope);
    if (!op) return { scope, status: 'skipped' };
    try {
      const copied = await op(parent, child);
      return { scope, status: 'ok', copied };
    } catch (err) {
      return {
        scope,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private opFor(scope: CloneScope): ((p: string, c: string) => Promise<number>) | undefined {
    switch (scope) {
      case 'memories': return this.infra.copyMemories;
      case 'projects': return this.infra.copyProjects;
      case 'org_graph': return this.infra.copyOrgGraph;
      case 'connectors_recommend': return this.infra.recommendConnectors;
      case 'settings': return this.infra.copySettings;
    }
  }
}

/**
 * Pure validator — checks that a clone request is well-formed before the
 * seeder consumes it. Reusable from the identity-service grant-create flow
 * and the bootstrap step.
 */
export function validateCloneRequest(req: CloneRequest): { ok: true } | { ok: false; error: string } {
  if (!req.parentTenantId || !req.childTenantId) {
    return { ok: false, error: 'missing tenant ids' };
  }
  if (req.parentTenantId === req.childTenantId) {
    return { ok: false, error: 'self-lineage not allowed' };
  }
  if (req.scopes.length === 0) {
    return { ok: false, error: 'empty scope list' };
  }
  const allowed: readonly CloneScope[] = ['memories', 'projects', 'org_graph', 'connectors_recommend', 'settings'];
  for (const s of req.scopes) {
    if (!allowed.includes(s)) return { ok: false, error: `unknown scope: ${s}` };
  }
  return { ok: true };
}
