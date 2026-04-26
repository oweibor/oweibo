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

import type {
  BrowserAction,
  BrowserActionResult,
  BrowserCookie,
  IBrowserExecutionContext,
} from '@oweibo/core-contracts';

/** Minimal bridge surface this action needs. */
export interface ICookieBridge {
  hasActiveSession(tenantId: string): boolean;
  sendAction(callId: string, action: BrowserAction, tenantId: string): Promise<unknown>;
}

export class BrowserPolicyViolationError extends Error {
  constructor(message: string) { super(message); this.name = 'BrowserPolicyViolationError'; }
}

export class ImportCookiesAction {
  constructor(private readonly bridge: ICookieBridge) {}

  async execute(
    action: Extract<BrowserAction, { type: 'import-cookies' }>,
    context: IBrowserExecutionContext,
  ): Promise<BrowserActionResult> {
    if (!context.securityContext.allowCookieImport) {
      throw new BrowserPolicyViolationError(
        'import-cookies requires securityContext.allowCookieImport=true.',
      );
    }
    if (!this.bridge.hasActiveSession(context.tenantId)) {
      return this.fail(
        'import-cookies requires an active extension bridge session (backend=extension).',
        'NO_EXTENSION_SESSION',
      );
    }
    if (!action.domain || typeof action.domain !== 'string') {
      return this.fail('import-cookies: missing or invalid domain.', 'INVALID_INPUT');
    }

    let cookies: BrowserCookie[];
    try {
      cookies = (await this.bridge.sendAction(
        crypto.randomUUID(),
        { type: 'import-cookies', domain: action.domain },
        context.tenantId,
      )) as BrowserCookie[];
    } catch (e) {
      return this.fail(`import-cookies bridge call failed: ${(e as Error).message}`, 'BRIDGE_ERROR');
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
      await this.bridge.sendAction(
        crypto.randomUUID(),
        { type: 'set-cookies', cookies },
        context.tenantId,
      );
    } catch (e) {
      return this.fail(`set-cookies follow-up failed: ${(e as Error).message}`, 'APPLY_FAILED');
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

  private fail(observation: string, error: string): BrowserActionResult {
    return { success: false, actionType: 'import-cookies', observation, error };
  }
}
