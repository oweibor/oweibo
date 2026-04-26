"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImportCookiesAction = exports.BrowserPolicyViolationError = void 0;
class BrowserPolicyViolationError extends Error {
    constructor(message) { super(message); this.name = 'BrowserPolicyViolationError'; }
}
exports.BrowserPolicyViolationError = BrowserPolicyViolationError;
class ImportCookiesAction {
    bridge;
    constructor(bridge) {
        this.bridge = bridge;
    }
    async execute(action, context) {
        if (!context.securityContext.allowCookieImport) {
            throw new BrowserPolicyViolationError('import-cookies requires securityContext.allowCookieImport=true.');
        }
        if (!this.bridge.hasActiveSession(context.tenantId)) {
            return this.fail('import-cookies requires an active extension bridge session (backend=extension).', 'NO_EXTENSION_SESSION');
        }
        if (!action.domain || typeof action.domain !== 'string') {
            return this.fail('import-cookies: missing or invalid domain.', 'INVALID_INPUT');
        }
        let cookies;
        try {
            cookies = (await this.bridge.sendAction(crypto.randomUUID(), { type: 'import-cookies', domain: action.domain }, context.tenantId));
        }
        catch (e) {
            return this.fail(`import-cookies bridge call failed: ${e.message}`, 'BRIDGE_ERROR');
        }
        if (!Array.isArray(cookies) || cookies.length === 0) {
            return {
                success: false,
                actionType: 'import-cookies',
                observation: `No cookies found for "${action.domain}".`,
                error: 'NO_COOKIES_FOUND',
            };
        }
        // Apply to the session via set-cookies. Values flow through the same
        // HMAC-authenticated bridge; never logged.
        try {
            await this.bridge.sendAction(crypto.randomUUID(), { type: 'set-cookies', cookies }, context.tenantId);
        }
        catch (e) {
            return this.fail(`set-cookies follow-up failed: ${e.message}`, 'APPLY_FAILED');
        }
        context.eventEmitter.emit('browser-cookies-imported', {
            domain: action.domain,
            cookieCount: cookies.length,
            tenantId: context.tenantId,
            taskId: context.taskId,
        });
        return {
            success: true,
            actionType: 'import-cookies',
            observation: `Imported ${cookies.length} cookie(s) for ${action.domain}.`,
            // NOTE: deliberately omitting `data` so cookie values cannot leak.
            data: { domain: action.domain, cookieCount: cookies.length },
        };
    }
    fail(observation, error) {
        return { success: false, actionType: 'import-cookies', observation, error };
    }
}
exports.ImportCookiesAction = ImportCookiesAction;
//# sourceMappingURL=ImportCookiesAction.js.map