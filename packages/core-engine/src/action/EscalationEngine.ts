/**
 * S.1: EscalationEngine — resolves approvers for a require_approval
 * proposal based on the policy's `approverResolution` strategy:
 *
 *   - `org_graph`     → walk OrgGraphService.resolveApprovers() then
 *                       widen the set at each escalation stage by
 *                       following `reports_to` edges up the chain.
 *   - `role_based`    → look up `tenant_memberships` rows whose roles
 *                       array intersects `approverConfig.roles`.
 *   - `explicit_list` → use the literal `approverConfig.users` array.
 *
 * Stage 0 is the initial dispatch. Stage N (N >= 1) widens the set by
 * walking up `reports_to` edges from the previous stage's nodes.
 *
 * Pure-data dependencies are injectable: the OrgGraphService and a
 * `tenant_memberships` reader are passed in so the engine can be unit-
 * tested without a live DB.
 */
import type {
  ApprovalSlaPolicy,
  ApproverResolutionKind,
} from '@oweibo/core-contracts';

export interface EscalationStageResult {
  /** UserIds invited to approve at this stage (union of all prior stages). */
  readonly approverUserIds: readonly string[];
  /** Distinct OrgNode ids contributing to this stage (when org_graph). */
  readonly orgNodeIds: readonly string[];
  /** True when the engine has exhausted the chain. */
  readonly chainExhausted: boolean;
}

/**
 * Pluggable org-graph adapter. Tests pass an in-memory implementation;
 * production wires this to OrgGraphService from the org/ package.
 */
export interface IOrgGraphReader {
  resolveApprovers(tenantId: string, actionClass: string): Promise<{
    readonly nodes: readonly string[];
    readonly users: readonly string[];
    readonly fromGraph: boolean;
  }>;
  /** Walk `reports_to` edges one level up from the given org nodes. */
  reportsTo(tenantId: string, nodeIds: readonly string[]): Promise<{
    readonly nodes: readonly string[];
    readonly users: readonly string[];
  }>;
}

export interface ITenantRoleReader {
  /** Return user ids whose roles intersect the given role names. */
  usersWithRoles(tenantId: string, roles: readonly string[]): Promise<readonly string[]>;
}

export interface IEscalationLogger {
  /**
   * Audit-fix: invoked when the escalation chain stops short of the
   * policy's full escalateAfterSeconds schedule (org-graph dead-end,
   * empty role/explicit set, etc.). Lets the lifecycle worker surface
   * "no one upstream to ask" as an operator-visible event instead of
   * a silent stall.
   */
  chainExhausted(args: {
    readonly tenantId: string;
    readonly actionClass: string;
    readonly stage: number;
    readonly reason: 'no_org_graph' | 'no_reports_to' | 'role_set_empty' | 'explicit_list_empty';
    readonly approverUserIds: readonly string[];
  }): void;
}

export interface EscalationEngineOptions {
  org: IOrgGraphReader;
  roles: ITenantRoleReader;
  log?: IEscalationLogger;
}

export class EscalationEngine {
  private readonly log: IEscalationLogger;

  constructor(private readonly opts: EscalationEngineOptions) {
    this.log = opts.log ?? {
      chainExhausted: (args) =>
        console.warn(`[EscalationEngine] chain exhausted at stage ${args.stage}`, args),
    };
  }

  async resolveStage(args: {
    readonly tenantId: string;
    readonly actionClass: string;
    readonly policy: ApprovalSlaPolicy;
    readonly stage: number;
    /** Prior stage's OrgNode ids — used by org_graph to walk up the chain. */
    readonly priorOrgNodeIds: readonly string[];
    /** Prior stage's user set — accumulated across stages. */
    readonly priorUserIds: readonly string[];
  }): Promise<EscalationStageResult> {
    switch (args.policy.approverResolution) {
      case 'org_graph':
        return this.resolveOrgGraph(args);
      case 'role_based':
        return this.resolveRoleBased(args);
      case 'explicit_list':
        return this.resolveExplicitList(args);
    }
  }

  private async resolveOrgGraph(args: {
    readonly tenantId: string;
    readonly actionClass: string;
    readonly stage: number;
    readonly priorOrgNodeIds: readonly string[];
    readonly priorUserIds: readonly string[];
  }): Promise<EscalationStageResult> {
    if (args.stage === 0) {
      const r = await this.opts.org.resolveApprovers(args.tenantId, args.actionClass);
      if (!r.fromGraph) {
        // Org graph isn't configured for this class — fall back to tenant
        // admin role lookup so we still have someone to notify.
        const admins = await this.opts.roles.usersWithRoles(args.tenantId, ['tenant_admin']);
        const ids = dedupe(admins);
        this.log.chainExhausted({
          tenantId: args.tenantId,
          actionClass: args.actionClass,
          stage: args.stage,
          reason: 'no_org_graph',
          approverUserIds: ids,
        });
        return { approverUserIds: ids, orgNodeIds: [], chainExhausted: true };
      }
      return {
        approverUserIds: dedupe(r.users),
        orgNodeIds: r.nodes,
        chainExhausted: false,
      };
    }
    if (args.priorOrgNodeIds.length === 0) {
      const ids = dedupe(args.priorUserIds);
      this.log.chainExhausted({
        tenantId: args.tenantId,
        actionClass: args.actionClass,
        stage: args.stage,
        reason: 'no_reports_to',
        approverUserIds: ids,
      });
      return { approverUserIds: ids, orgNodeIds: [], chainExhausted: true };
    }
    const next = await this.opts.org.reportsTo(args.tenantId, args.priorOrgNodeIds);
    if (next.nodes.length === 0) {
      const ids = dedupe(args.priorUserIds);
      this.log.chainExhausted({
        tenantId: args.tenantId,
        actionClass: args.actionClass,
        stage: args.stage,
        reason: 'no_reports_to',
        approverUserIds: ids,
      });
      return { approverUserIds: ids, orgNodeIds: [], chainExhausted: true };
    }
    return {
      approverUserIds: dedupe([...args.priorUserIds, ...next.users]),
      orgNodeIds: next.nodes,
      chainExhausted: false,
    };
  }

  private async resolveRoleBased(args: {
    readonly tenantId: string;
    readonly actionClass: string;
    readonly policy: ApprovalSlaPolicy;
    readonly stage: number;
    readonly priorUserIds: readonly string[];
  }): Promise<EscalationStageResult> {
    if (args.stage > 0) {
      // Role-based has no escalation chain; subsequent stages re-fire the
      // same recipient set so they get reminded.
      return {
        approverUserIds: dedupe(args.priorUserIds),
        orgNodeIds: [],
        chainExhausted: true,
      };
    }
    const cfg = (args.policy.approverConfig ?? {}) as { roles?: readonly string[] };
    const roles = cfg.roles && cfg.roles.length > 0 ? cfg.roles : ['tenant_admin'];
    const users = await this.opts.roles.usersWithRoles(args.tenantId, roles);
    const ids = dedupe(users);
    if (ids.length === 0) {
      this.log.chainExhausted({
        tenantId: args.tenantId,
        actionClass: args.actionClass,
        stage: args.stage,
        reason: 'role_set_empty',
        approverUserIds: ids,
      });
    }
    return { approverUserIds: ids, orgNodeIds: [], chainExhausted: true };
  }

  private async resolveExplicitList(args: {
    readonly tenantId: string;
    readonly actionClass: string;
    readonly policy: ApprovalSlaPolicy;
    readonly stage: number;
    readonly priorUserIds: readonly string[];
  }): Promise<EscalationStageResult> {
    if (args.stage > 0) {
      return {
        approverUserIds: dedupe(args.priorUserIds),
        orgNodeIds: [],
        chainExhausted: true,
      };
    }
    const cfg = (args.policy.approverConfig ?? {}) as { users?: readonly string[] };
    const ids = dedupe(cfg.users ?? []);
    if (ids.length === 0) {
      this.log.chainExhausted({
        tenantId: args.tenantId,
        actionClass: args.actionClass,
        stage: args.stage,
        reason: 'explicit_list_empty',
        approverUserIds: ids,
      });
    }
    return { approverUserIds: ids, orgNodeIds: [], chainExhausted: true };
  }
}

function dedupe(xs: readonly string[]): readonly string[] {
  return Array.from(new Set(xs));
}

export type { ApproverResolutionKind };

// Production DB-backed adapters live in their own files:
//   ./PgOrgGraphReader.ts   — IOrgGraphReader
//   ./PgTenantRoleReader.ts — ITenantRoleReader
// They were moved here for the F.1.5 wiring; the engine itself is pure
// (test-able with in-memory fakes).
