import type { BrowserAction, BrowserActionResult, BrowserTabState, IBrowserExecutionContext, IBrowserTool } from '@oweibo/core-contracts';
import type { BrowserSessionManager } from '../session/BrowserSessionManager.js';
import { type ICookieBridge } from './actions/ImportCookiesAction.js';
import { type IAutofillBridge } from './actions/AutofillCredentialsAction.js';
import { type IGateResolver } from './actions/ExtensionHitlRespondAction.js';
export declare class BrowserTool implements IBrowserTool {
    private readonly sessions;
    private readonly importCookiesAction;
    private readonly autofillCredentialsAction;
    private readonly extensionHitlRespondAction;
    constructor(sessions: BrowserSessionManager, cookieBridge: ICookieBridge, autofillBridge: IAutofillBridge, gateResolver: IGateResolver);
    execute(action: BrowserAction, context: IBrowserExecutionContext): Promise<BrowserActionResult>;
    destroySession(tenantId: string, sessionId: string): Promise<void>;
    listTabs(tenantId: string, sessionId: string): Promise<BrowserTabState[]>;
    private dispatch;
    private shot;
    private captureSnapshot;
    private ok;
    private fail;
}
//# sourceMappingURL=BrowserTool.d.ts.map