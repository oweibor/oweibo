/**
 * DialogAutoPolicy — per-type auto-accept/dismiss/hitl policy for browser dialogs.
 * (NEW v9.5.4)
 *
 * Default policy:
 *   - alert, beforeunload: always auto-dismiss (no meaningful user input needed)
 *   - confirm, prompt:     HITL in supervised mode; auto-accept in autonomous mode
 *
 * Tenant-configurable via Vault: oweibo/tenants/{tenantId}/browser/dialog-policy
 */
import type { BrowserDialogEvent, DialogAnswer } from '@oweibo/core-contracts';
export type DialogHandlingMode = 'auto-accept' | 'auto-dismiss' | 'hitl';
export interface DialogPolicyConfig {
    alert: DialogHandlingMode;
    confirm: DialogHandlingMode;
    prompt: DialogHandlingMode;
    beforeunload: DialogHandlingMode;
}
export declare class DialogAutoPolicy {
    private readonly config;
    constructor(config: DialogPolicyConfig);
    static forSupervised(override?: Partial<DialogPolicyConfig>): DialogAutoPolicy;
    static forAutonomous(override?: Partial<DialogPolicyConfig>): DialogAutoPolicy;
    /**
     * Returns true if the policy dictates automatic handling (not HITL).
     */
    shouldAutoHandle(event: BrowserDialogEvent): boolean;
    /**
     * Resolve the dialog according to the auto policy. Only call if shouldAutoHandle() === true.
     */
    resolve(event: BrowserDialogEvent): DialogAnswer;
    getMode(type: BrowserDialogEvent['type']): DialogHandlingMode;
}
//# sourceMappingURL=DialogAutoPolicy.d.ts.map