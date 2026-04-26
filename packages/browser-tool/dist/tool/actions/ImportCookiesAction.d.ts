/**
 * ImportCookiesAction (v9.5.9) — Reads the user's real Chrome cookies for a
 * domain via the extension bridge and applies them to the active session.
 *
 * Extension-mode only. The cookie *values* never appear in the action result,
 * never reach Redis session state, never touch BrowserDlpFilter input. Only
 * the domain and cookie count are surfaced to the agent and audit log.
 *
 * Trust gate: `securityContext.allowCookieImport`.
 * Event:      `browser-cookies-imported` (domain, cookieCount, tenantId, taskId)
 */
import type { BrowserAction, BrowserActionResult, IBrowserExecutionContext } from '@oweibo/core-contracts';
/** Minimal bridge surface this action needs. */
export interface ICookieBridge {
    hasActiveSession(tenantId: string): boolean;
    sendAction(callId: string, action: BrowserAction, tenantId: string): Promise<unknown>;
}
export declare class BrowserPolicyViolationError extends Error {
    constructor(message: string);
}
export declare class ImportCookiesAction {
    private readonly bridge;
    constructor(bridge: ICookieBridge);
    execute(action: Extract<BrowserAction, {
        type: 'import-cookies';
    }>, context: IBrowserExecutionContext): Promise<BrowserActionResult>;
    private fail;
}
//# sourceMappingURL=ImportCookiesAction.d.ts.map