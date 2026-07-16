/**
 * K.7 — ConnectorActionService: the connector-facing ActionPort execution
 * path (arch §4.4). It WRAPS the shipped action-safety layer — it never
 * reimplements gating, floors, dry-run, or approvals:
 *
 *   1. derive the action_class from the capability's DECLARED class
 *      (content-independent, INV-11 — retrieved content is NOT an input);
 *   2. run the shipped ActionTrustLadder gate (execute / dry_run / shadow /
 *      require_approval / forbidden / rate_limited);
 *   3. dispatch — ONLY `execute` touches the live system, under a short-lived
 *      delegated token (§12.3) resolved at egress (INV-10), with before/after
 *      audit (§4.4). dry_run/shadow/require_approval record a proposal and do
 *      NOT execute; forbidden is refused.
 *
 * A prompt-injected instruction in the payload's content cannot escalate the
 * action: the gate MODE is a function of (tenant, declared action_class) plus
 * upgrade-only inspectors — content can only make the gate STRICTER (ADR-011).
 */

import type { ActionContext, GateDecision, IActionGate, RollbackEnvelope, TenantReadinessSnapshot } from '@oweibo/core-contracts';
import { gateActionClass, type GatedCapability } from './contentTrust.js';
import type { DelegatedTokenService, DelegatedTokenHandle } from './DelegatedTokenService.js';

/** Structural mirror of a connector's action invocation (egress side). */
export interface ActionPortExecutor<Ctx> {
  /** Invoke the live action. The delegated token handle is resolved at egress; credentials never reach here in the clear. */
  invoke(ctx: Ctx, payload: unknown, token?: DelegatedTokenHandle): Promise<unknown>;
}

export type ActionAuditEvent =
  | { readonly phase: 'before'; readonly tenantId: string; readonly actionClass: string; readonly actionId: string; readonly summary: string }
  | { readonly phase: 'after'; readonly tenantId: string; readonly actionClass: string; readonly actionId: string }
  | { readonly phase: 'failed'; readonly tenantId: string; readonly actionClass: string; readonly actionId: string; readonly error: string };

export type ActionAuditor = (event: ActionAuditEvent) => void | Promise<void>;

export interface ExecuteActionInput<Ctx> {
  readonly tenantId: string;
  readonly userId: string;
  /** The connector capability being invoked — its DECLARED class is the gate input (INV-11). */
  readonly capability: GatedCapability;
  /** Machine-readable action detail from the PLAN (not free-form retrieved content). */
  readonly payload: unknown;
  readonly summary: string;
  readonly actionId: string;
  readonly calibrationSnapshot: TenantReadinessSnapshot;
  readonly rollback?: RollbackEnvelope;
  readonly principalScopes?: readonly string[];
  readonly executor: ActionPortExecutor<Ctx>;
  readonly ctx: Ctx;
  /** Mints the raw scoped token for delegated mode; resolved write-only, never echoed (INV-10). */
  readonly mintRawToken?: () => Promise<string>;
}

export type ActionExecutionResult =
  | { readonly status: 'executed'; readonly result: unknown }
  | { readonly status: 'dry_run'; readonly proposalId: string }
  | { readonly status: 'shadow'; readonly shadowId: string }
  | { readonly status: 'require_approval'; readonly approvalId: string }
  | { readonly status: 'forbidden'; readonly reason: string }
  | { readonly status: 'rate_limited'; readonly retryAfterMs: number }
  | { readonly status: 'failed'; readonly error: string };

export interface ConnectorActionServiceOptions {
  readonly tokenService?: DelegatedTokenService;
  readonly audit?: ActionAuditor;
}

export class ConnectorActionService {
  constructor(
    private readonly gate: IActionGate,
    private readonly opts: ConnectorActionServiceOptions = {},
  ) {}

  async execute<Ctx>(input: ExecuteActionInput<Ctx>): Promise<ActionExecutionResult> {
    // ── INV-11: the gate's action_class is the capability's DECLARED class —
    // never derived from the payload's content. ────────────────────────────
    const actionClass = gateActionClass(input.capability);

    const ctx: ActionContext = {
      tenantId: input.tenantId,
      userId: input.userId,
      actionClass: actionClass as ActionContext['actionClass'],
      actionId: input.actionId,
      summary: input.summary,
      payload: input.payload,
      calibrationSnapshot: input.calibrationSnapshot,
      ...(input.rollback ? { rollback: input.rollback } : {}),
      ...(input.principalScopes ? { principalScopes: input.principalScopes } : {}),
    };

    const decision: GateDecision = await this.gate.gate(ctx);

    switch (decision.mode) {
      case 'execute':
        return this.runLive(input, actionClass);
      case 'dry_run':
        return { status: 'dry_run', proposalId: decision.proposalId };
      case 'shadow':
        return { status: 'shadow', shadowId: decision.shadowId };
      case 'require_approval':
        return { status: 'require_approval', approvalId: decision.approvalId };
      case 'forbidden':
        return { status: 'forbidden', reason: decision.reason };
      case 'rate_limited':
        return { status: 'rate_limited', retryAfterMs: decision.retryAfterMs };
    }
  }

  /**
   * The ONLY path that touches the live system. Issues a short-lived delegated
   * token (§12.3), invokes the ActionPort under before/after audit (§4.4), and
   * expires the token if the action never redeemed it.
   */
  private async runLive<Ctx>(input: ExecuteActionInput<Ctx>, actionClass: string): Promise<ActionExecutionResult> {
    let handle: DelegatedTokenHandle | undefined;
    if (this.opts.tokenService && input.mintRawToken) {
      handle = await this.opts.tokenService.issue({
        tenantId: input.tenantId, userId: input.userId, actionClass,
        rawToken: await input.mintRawToken(),
      });
    }

    await this.emit({ phase: 'before', tenantId: input.tenantId, actionClass, actionId: input.actionId, summary: input.summary });
    try {
      const result = await input.executor.invoke(input.ctx, input.payload, handle);
      await this.emit({ phase: 'after', tenantId: input.tenantId, actionClass, actionId: input.actionId });
      return { status: 'executed', result };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // Failed actions never silently succeed (§4.4); expire any unredeemed token.
      if (handle && this.opts.tokenService) await this.opts.tokenService.expire(handle.handle).catch(() => undefined);
      await this.emit({ phase: 'failed', tenantId: input.tenantId, actionClass, actionId: input.actionId, error });
      return { status: 'failed', error };
    }
  }

  private async emit(event: ActionAuditEvent): Promise<void> {
    if (!this.opts.audit) return;
    try {
      await this.opts.audit(event);
    } catch {
      // Audit must be before/after but must not itself break a completed action.
    }
  }
}
