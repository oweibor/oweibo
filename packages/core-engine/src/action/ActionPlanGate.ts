/**
 * S.0: ActionPlanGate — plan-level approval gate.
 *
 * The per-action gate (T.−1 ActionTrustLadder) decides one action at a
 * time. ActionPlanGate decides for an entire plan: it computes the
 * aggregate blast radius, walks the per-action gate decisions, and
 * collapses them into one of three plan-level modes:
 *
 *   - `execute_each`             — each action will re-gate individually
 *   - `require_approval_for_plan` — one approval covers every member
 *                                   action; a single `action_proposals`
 *                                   row is written with `step_number=NULL`
 *   - `forbidden`                 — at least one action is hard-pinned
 *                                   forbidden
 *
 * Backwards compatibility: if the feature flag is off, `gatePlan()`
 * returns `execute_each` deterministically and writes nothing. Existing
 * per-action gating remains the sole control.
 *
 * Hard-pinned classes (financial, personnel, irreversible, deploy-prod)
 * always force `require_approval_for_plan` even if their per-tenant
 * state would otherwise allow `execute`. The plan-approval UI surfaces
 * these so the approver sees what they're signing off on.
 */
import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  ActionPlan,
  PlannedAction,
  PlanGateDecision,
  BlastRadius,
  ActionClass,
} from '@oweibo/core-contracts';
import { BlastRadiusComputer } from './BlastRadiusComputer.js';

// Classes that always trigger plan-level approval regardless of per-tenant
// per-class state. Mirrors ActionTrustLadder.CLASSES_ALWAYS_REQUIRE_APPROVAL
// plus the deploy.prod / write.*.prod axis — re-listed here to avoid pulling
// in the runtime ladder.
const PLAN_FORCE_APPROVAL_CLASSES: ReadonlySet<string> = new Set([
  'financial.payment',
  'personnel.access_grant',
  'personnel.access_revoke',
  'irreversible.delete_resource',
  'irreversible.public_publish',
  'deploy.prod',
  'write.external_api.prod',
  'write.tenant_db.prod',
]);

export interface ActionPlanGateOptions {
  /** When false, gatePlan() returns execute_each unconditionally. */
  isEnabled?: () => boolean;
  /**
   * Tenant plan-budget ceiling in USD cents. Plans whose aggregate cost
   * exceeds this trigger plan-level approval even when every action would
   * individually execute. Default 50_000 ($500).
   */
  planCostCeilingUsdCents?: (tenantId: string) => Promise<number>;
  /** Override clock; used by tests. */
  now?: () => Date;
}

export class ActionPlanGate {
  private readonly isEnabled: () => boolean;
  private readonly planCostCeiling: (tenantId: string) => Promise<number>;
  private readonly now: () => Date;

  constructor(private readonly pool: Pool, opts: ActionPlanGateOptions = {}) {
    this.isEnabled = opts.isEnabled ?? defaultEnabled;
    this.planCostCeiling = opts.planCostCeilingUsdCents ?? (async () => 50_000);
    this.now = opts.now ?? (() => new Date());
  }

  async gatePlan(plan: ActionPlan): Promise<PlanGateDecision> {
    if (!this.isEnabled()) {
      return {
        mode: 'execute_each',
        blastRadius: BlastRadiusComputer.aggregate(plan.actions.map((a) => a.blastRadiusContribution)),
      };
    }

    // 1. Structural validation. Fail fast on malformed plans.
    const structural = validatePlanStructure(plan.actions);
    if (!structural.ok) {
      return {
        mode: 'forbidden',
        reason: structural.error,
        blastRadius: BlastRadiusComputer.aggregate(plan.actions.map((a) => a.blastRadiusContribution)),
      };
    }

    // 2. Compute aggregate blast radius.
    const blastRadius = BlastRadiusComputer.aggregate(plan.actions.map((a) => a.blastRadiusContribution));

    // 3. Class-level checks: forbidden / force-approval classes.
    const forbiddenAction = plan.actions.find((a) => isClassForbidden(a.actionClass));
    if (forbiddenAction) {
      return {
        mode: 'forbidden',
        reason: `class ${forbiddenAction.actionClass} is forbidden`,
        blastRadius,
      };
    }
    const forceApproval = plan.actions.some((a) => PLAN_FORCE_APPROVAL_CLASSES.has(a.actionClass));

    // Audit-fix (S.0 #10): refuse all_or_nothing plans that contain any
    // hard-pinned class. Once steps 1..k-1 execute, a per-action gate
    // STILL fires `require_approval` for step k (CLASSES_ALWAYS_REQUIRE_
    // APPROVAL is enforced by ActionTrustLadder independently), and an
    // operator rejection mid-plan leaves the plan stuck — there is no
    // rollback_pending state pre-S.3, and even with S.3, `all_or_nothing`
    // means a single mid-plan rejection has to roll back every prior
    // step. The right answer is to reject the plan at gate time so the
    // caller switches atomicity to `sequential_with_checkpoints`.
    if (plan.atomicity === 'all_or_nothing' && forceApproval) {
      const offender = plan.actions.find((a) => PLAN_FORCE_APPROVAL_CLASSES.has(a.actionClass));
      return {
        mode: 'forbidden',
        reason:
          `all_or_nothing plan contains hard-pinned class '${offender?.actionClass}'; ` +
          `switch atomicity to 'sequential_with_checkpoints' so a mid-plan rejection ` +
          `does not deadlock the plan`,
        blastRadius,
      };
    }

    // 4. Budget ceiling. A null cost (unknown) doesn't trip the ceiling
    //    on its own — S.6's QuotaService is the right place to fall back
    //    to the BudgetEstimator. Treat null as "no plan-level cost signal."
    const ceiling = await this.planCostCeiling(plan.tenantId);
    const planCost = blastRadius.estimatedCostUsdCents;
    const overBudget = planCost !== null && planCost > ceiling;

    if (!forceApproval && !overBudget) {
      return { mode: 'execute_each', blastRadius };
    }

    // 5. Write the plan-level proposal row + ActionPlan row + lineage gate
    //    decision. All inside one transaction so a failure rolls everything
    //    back — no orphan proposal pointing at a missing plan.
    const planProposalId = await this.writePlanApproval(plan, blastRadius, overBudget, forceApproval);
    return {
      mode: 'require_approval_for_plan',
      planProposalId,
      blastRadius,
    };
  }

  private async writePlanApproval(
    plan: ActionPlan,
    blastRadius: BlastRadius,
    overBudget: boolean,
    forceApproval: boolean,
  ): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await setTenantScope(client, plan.tenantId);
      const planId = plan.planId || randomUUID();

      await client.query(
        `INSERT INTO oweibo.action_plans (
           id, tenant_id, user_id, originating_task_id, title, atomicity,
           state, worst_reversibility, systems, data_domains,
           estimated_cost_usd_cents, estimated_reach_user_count, created_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6,
           'pending', $7, $8::text[], $9::text[], $10, $11, NOW()
         )
         ON CONFLICT (id) DO NOTHING`,
        [
          planId,
          plan.tenantId,
          plan.userId || null,
          plan.originatingTaskId || null,
          plan.title,
          plan.atomicity,
          blastRadius.worstReversibility,
          blastRadius.systems,
          blastRadius.dataDomains,
          blastRadius.estimatedCostUsdCents,
          blastRadius.estimatedReachUserCount,
        ],
      );

      // One plan-level proposal row. step_number=NULL marks it as the
      // plan approval (vs per-action approvals which have step_number set).
      const proposalActionId = `plan:${planId}`;
      const reason = overBudget
        ? `plan exceeds budget ceiling ($${(blastRadius.estimatedCostUsdCents / 100).toFixed(2)})`
        : 'plan contains class requiring approval';
      const proposal = await client.query<{ id: string }>(
        `INSERT INTO oweibo.action_proposals (
           id, tenant_id, user_id, action_class, action_id, mode, summary,
           payload, state, created_at, expires_at, plan_id, step_number,
           depends_on_steps, blast_radius_contribution
         ) VALUES (
           gen_random_uuid(), $1::uuid, $2::uuid, 'plan', $3, 'require_approval', $4,
           $5::jsonb, 'pending', NOW(), NOW() + INTERVAL '7 days', $6::uuid, NULL,
           '{}', NULL
         )
         ON CONFLICT (tenant_id, action_id) DO UPDATE SET action_id = EXCLUDED.action_id
         RETURNING id`,
        [
          plan.tenantId,
          plan.userId || null,
          proposalActionId,
          `${plan.title} — ${reason}`,
          JSON.stringify({
            planId,
            title: plan.title,
            actionCount: plan.actions.length,
            blastRadius,
            forceApproval,
            overBudget,
          }),
          planId,
        ],
      );
      const proposalId = proposal.rows[0]?.id;
      if (!proposalId) throw new Error('writePlanApproval: insert returned no id');

      await client.query(
        `UPDATE oweibo.action_plans SET plan_proposal_id = $1::uuid WHERE id = $2::uuid`,
        [proposalId, planId],
      );

      await client.query('COMMIT');
      return proposalId;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

// ── Pure helpers exported for unit tests ────────────────────────────────

/**
 * Validate that the per-action `dependsOn` list forms a DAG over step
 * numbers [1..N]. Detects (a) unknown step numbers, (b) self-reference,
 * (c) cycles via DFS on the reverse-dependency graph.
 */
export function validatePlanStructure(
  actions: readonly PlannedAction[],
): { ok: true } | { ok: false; error: string } {
  if (actions.length === 0) {
    return { ok: false, error: 'empty plan' };
  }
  const seenSteps = new Set<number>();
  for (const a of actions) {
    if (seenSteps.has(a.stepNumber)) {
      return { ok: false, error: `duplicate step ${a.stepNumber}` };
    }
    seenSteps.add(a.stepNumber);
  }
  for (const a of actions) {
    for (const d of a.dependsOn ?? []) {
      if (!seenSteps.has(d)) {
        return { ok: false, error: `step ${a.stepNumber} depends on unknown step ${d}` };
      }
      if (d === a.stepNumber) {
        return { ok: false, error: `step ${a.stepNumber} depends on itself` };
      }
    }
  }
  if (hasCycle(actions)) {
    return { ok: false, error: 'plan contains a dependency cycle' };
  }
  return { ok: true };
}

function hasCycle(actions: readonly PlannedAction[]): boolean {
  // DFS with three-colour marking. White=unvisited, Gray=in current path,
  // Black=fully explored.
  const White = 0, Gray = 1, Black = 2;
  const color = new Map<number, number>();
  for (const a of actions) color.set(a.stepNumber, White);
  const depsByStep = new Map<number, readonly number[]>();
  for (const a of actions) depsByStep.set(a.stepNumber, a.dependsOn ?? []);

  function dfs(step: number): boolean {
    color.set(step, Gray);
    for (const d of depsByStep.get(step) ?? []) {
      const c = color.get(d);
      if (c === Gray) return true; // back-edge ⇒ cycle
      if (c === White && dfs(d)) return true;
    }
    color.set(step, Black);
    return false;
  }

  for (const a of actions) {
    if (color.get(a.stepNumber) === White) {
      if (dfs(a.stepNumber)) return true;
    }
  }
  return false;
}

export function isClassForbidden(actionClass: ActionClass): boolean {
  // Symmetrically with ActionTrustLadder, "forbidden" is a pinned per-tenant
  // state — there's no class that's always forbidden by default. Plan-level
  // pre-check returns false here; runtime per-action gate may still forbid.
  void actionClass;
  return false;
}

function defaultEnabled(): boolean {
  return process.env.ACTION_PLAN_GATE_ENABLED === 'true';
}

async function setTenantScope(client: PoolClient, tenantId: string): Promise<void> {
  if (/^[0-9a-f-]{36}$/i.test(tenantId)) {
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
  }
}
