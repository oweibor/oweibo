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
import type { BrowserAction, BrowserActionResult, IBrowserExecutionContext } from '@oweibo/core-contracts';
export interface IAutofillBridge {
    hasActiveSession(tenantId: string): boolean;
    sendAction(callId: string, action: BrowserAction, tenantId: string): Promise<unknown>;
    /** Resolve the active page URL for hostname extraction. */
    getActiveUrl(tenantId: string): Promise<string | null>;
}
export declare class BrowserPolicyViolationError extends Error {
    constructor(message: string);
}
export declare class AutofillCredentialsAction {
    private readonly bridge;
    constructor(bridge: IAutofillBridge);
    execute(action: Extract<BrowserAction, {
        type: 'autofill-credentials';
    }>, context: IBrowserExecutionContext): Promise<BrowserActionResult>;
    private fail;
}
//# sourceMappingURL=AutofillCredentialsAction.d.ts.map