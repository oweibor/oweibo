/**
 * DialogManager — attaches to a BrowserContext and handles native browser dialogs.
 * (NEW v9.5.4)
 *
 * - Automatically handles dialogs per DialogAutoPolicy.
 * - For HITL dialogs, parks them in a pending map and emits browser-dialog-pending.
 * - A 60-second safety timeout dismisses any unhandled dialog to prevent page lock.
 */
import type { DialogAnswer, IBrowserEventEmitter, PendingDialog } from '@oweibo/core-contracts';
import type { DialogAutoPolicy } from './DialogAutoPolicy.js';
export declare class DialogManager {
    private readonly pending;
    /**
     * Attach dialog listeners to a Playwright BrowserContext.
     * context is typed as `any` to avoid importing Playwright in the contract layer.
     */
    attachToContext(context: any, sessionId: string, tenantId: string, taskId: string, emitter: IBrowserEventEmitter, policy: DialogAutoPolicy): void;
    resolve(sessionId: string, answer: DialogAnswer): Promise<boolean>;
    hasPending(sessionId: string): boolean;
    getPending(sessionId: string): PendingDialog | undefined;
}
//# sourceMappingURL=DialogManager.d.ts.map