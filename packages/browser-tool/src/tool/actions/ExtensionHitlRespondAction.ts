/**
 * ExtensionHitlRespondAction (v9.5.9) — Internal pipeline action.
 *
 * The extension's HITLSurfaceCoordinator emits this action when ANY surface
 * (in-tab overlay, OS notification, popup) records a user response on a
 * pending gate. The node-side pipeline routes the response back to the
 * waiting DialogManager / VisionLoopGate.
 *
 * This action is NEVER produced by an LLM — it is generated only by the
 * extension bridge ingress path. Calling it directly from agent code is a
 * programming error and is rejected.
 */

import type {
  BrowserAction,
  BrowserActionResult,
  IBrowserExecutionContext,
} from '@oweibo/core-contracts';

/** Sink that the action notifies when a gate resolution arrives. */
export interface IGateResolver {
  /**
   * Resolve a pending gate by id. Returns true if the gate existed and was
   * resolved by this call, false if it was unknown or already resolved.
   */
  resolveGate(gateId: string, accept: boolean, promptText?: string): Promise<boolean>;
}

export class ExtensionHitlRespondAction {
  constructor(private readonly resolver: IGateResolver) {}

  /** Set on actions originating from the trusted bridge ingress path. */
  static readonly INTERNAL_MARKER = Symbol.for('oweibo.extensionHitlRespond.internal');

  /**
   * Mark an action as originating from the trusted bridge so the executor
   * accepts it. The bridge dispatcher applies this marker before invoking.
   */
  static markInternal<A extends { type: 'extension-hitl-respond' }>(action: A): A {
    Object.defineProperty(action, ExtensionHitlRespondAction.INTERNAL_MARKER, {
      value: true, enumerable: false,
    });
    return action;
  }

  async execute(
    action: Extract<BrowserAction, { type: 'extension-hitl-respond' }>,
    context: IBrowserExecutionContext,
  ): Promise<BrowserActionResult> {
    const isInternal = (action as unknown as Record<symbol, boolean>)[
      ExtensionHitlRespondAction.INTERNAL_MARKER
    ];
    if (!isInternal) {
      return this.fail(
        'extension-hitl-respond is reserved for the bridge ingress path.',
        'FORBIDDEN_DIRECT_INVOCATION',
      );
    }

    if (!action.gateId || typeof action.gateId !== 'string') {
      return this.fail('extension-hitl-respond: missing gateId.', 'INVALID_INPUT');
    }

    let resolved = false;
    try {
      resolved = await this.resolver.resolveGate(
        action.gateId, Boolean(action.accept), action.promptText,
      );
    } catch (e) {
      return this.fail(`gate resolution failed: ${(e as Error).message}`, 'RESOLVE_ERROR');
    }

    context.eventEmitter.emit('browser-hitl-resolved', {
      gateId: action.gateId,
      accept: Boolean(action.accept),
      tenantId: context.tenantId,
      taskId: context.taskId,
      idempotent: !resolved,
    });

    return {
      success: true,
      actionType: 'extension-hitl-respond',
      observation: resolved
        ? `Gate ${action.gateId} ${action.accept ? 'accepted' : 'dismissed'}.`
        : `Gate ${action.gateId} was already resolved (idempotent).`,
      data: { gateId: action.gateId, accept: Boolean(action.accept), idempotent: !resolved },
    };
  }

  private fail(observation: string, error: string): BrowserActionResult {
    return { success: false, actionType: 'extension-hitl-respond', observation, error };
  }
}
