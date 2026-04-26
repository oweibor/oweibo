"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AutofillCredentialsAction = exports.BrowserPolicyViolationError = void 0;
class BrowserPolicyViolationError extends Error {
    constructor(message) { super(message); this.name = 'BrowserPolicyViolationError'; }
}
exports.BrowserPolicyViolationError = BrowserPolicyViolationError;
class AutofillCredentialsAction {
    bridge;
    constructor(bridge) {
        this.bridge = bridge;
    }
    async execute(action, context) {
        if (!context.securityContext.allowAutofill) {
            throw new BrowserPolicyViolationError('autofill-credentials requires securityContext.allowAutofill=true.');
        }
        if (!this.bridge.hasActiveSession(context.tenantId)) {
            return this.fail('autofill-credentials requires an active extension bridge session.', 'NO_EXTENSION_SESSION');
        }
        try {
            await this.bridge.sendAction(crypto.randomUUID(), action, context.tenantId);
        }
        catch (e) {
            return this.fail(`autofill bridge call failed: ${e.message}`, 'BRIDGE_ERROR');
        }
        if (action.submitAfterFill) {
            // After autofill, the user typically presses Enter to submit. We can't
            // know with certainty when the user has selected a credential, so we
            // simply emit a snapshot to nudge the agent's vision loop. Real submit
            // is best handled by a follow-up `submit` action driven by vision.
        }
        let host;
        try {
            const url = await this.bridge.getActiveUrl(context.tenantId);
            host = url ? new URL(url).hostname : undefined;
        }
        catch { /* not fatal */ }
        return {
            success: true,
            actionType: 'autofill-credentials',
            observation: host
                ? `Triggered Chrome autofill on ${host}.`
                : 'Triggered Chrome autofill.',
            data: { host },
        };
    }
    fail(observation, error) {
        return { success: false, actionType: 'autofill-credentials', observation, error };
    }
}
exports.AutofillCredentialsAction = AutofillCredentialsAction;
//# sourceMappingURL=AutofillCredentialsAction.js.map