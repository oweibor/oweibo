/**
 * AutofillCredentialsAction (v9.5.9) — Triggers Chrome's native autofill
 * popup. The user picks a credential from Chrome's password manager; the
 * content script focuses the username field and dispatches a synthetic
 * ArrowDown to surface the dropdown.
 *
 * Oweibo NEVER sees the filled values:
 *   • HTMLInputElement.value returns '' for `type="password"` inputs that were
 *     filled by Chrome's autofill (Chrome security constraint).
 *   • The action result records only the target hostname (audit-friendly).
 *
 * Trust gate: `securityContext.allowAutofill`.
 */

import type {
  BrowserAction,
  BrowserActionResult,
  IBrowserExecutionContext,
} from '@oweibo/core-contracts';

export interface IAutofillBridge {
  hasActiveSession(tenantId: string): boolean;
  sendAction(callId: string, action: BrowserAction, tenantId: string): Promise<unknown>;
  /** Resolve the active page URL for hostname extraction. */
  getActiveUrl(tenantId: string): Promise<string | null>;
}

export class BrowserPolicyViolationError extends Error {
  constructor(message: string) { super(message); this.name = 'BrowserPolicyViolationError'; }
}

export class AutofillCredentialsAction {
  constructor(private readonly bridge: IAutofillBridge) {}

  async execute(
    action: Extract<BrowserAction, { type: 'autofill-credentials' }>,
    context: IBrowserExecutionContext,
  ): Promise<BrowserActionResult> {
    if (!context.securityContext.allowAutofill) {
      throw new BrowserPolicyViolationError(
        'autofill-credentials requires securityContext.allowAutofill=true.',
      );
    }
    if (!this.bridge.hasActiveSession(context.tenantId)) {
      return this.fail(
        'autofill-credentials requires an active extension bridge session.',
        'NO_EXTENSION_SESSION',
      );
    }

    try {
      await this.bridge.sendAction(
        crypto.randomUUID(),
        action,
        context.tenantId,
      );
    } catch (e) {
      return this.fail(`autofill bridge call failed: ${(e as Error).message}`, 'BRIDGE_ERROR');
    }

    if (action.submitAfterFill) {
      // After autofill, the user typically presses Enter to submit. We can't
      // know with certainty when the user has selected a credential, so we
      // simply emit a snapshot to nudge the agent's vision loop. Real submit
      // is best handled by a follow-up `submit` action driven by vision.
    }

    let host: string | undefined;
    try {
      const url = await this.bridge.getActiveUrl(context.tenantId);
      host = url ? new URL(url).hostname : undefined;
    } catch { /* not fatal */ }

    return {
      success: true,
      actionType: 'autofill-credentials',
      observation: host
        ? `Triggered Chrome autofill on ${host}.`
        : 'Triggered Chrome autofill.',
      data: { host },
    };
  }

  private fail(observation: string, error: string): BrowserActionResult {
    return { success: false, actionType: 'autofill-credentials', observation, error };
  }
}
