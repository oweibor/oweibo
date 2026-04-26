"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DialogAutoPolicy = void 0;
const SUPERVISED_DEFAULTS = {
    alert: 'auto-dismiss',
    confirm: 'hitl',
    prompt: 'hitl',
    beforeunload: 'auto-dismiss',
};
const AUTONOMOUS_DEFAULTS = {
    alert: 'auto-dismiss',
    confirm: 'auto-accept',
    prompt: 'auto-accept',
    beforeunload: 'auto-dismiss',
};
class DialogAutoPolicy {
    config;
    constructor(config) {
        this.config = config;
    }
    static forSupervised(override) {
        return new DialogAutoPolicy({ ...SUPERVISED_DEFAULTS, ...override });
    }
    static forAutonomous(override) {
        return new DialogAutoPolicy({ ...AUTONOMOUS_DEFAULTS, ...override });
    }
    /**
     * Returns true if the policy dictates automatic handling (not HITL).
     */
    shouldAutoHandle(event) {
        return this.config[event.type] !== 'hitl';
    }
    /**
     * Resolve the dialog according to the auto policy. Only call if shouldAutoHandle() === true.
     */
    resolve(event) {
        const mode = this.config[event.type];
        return {
            accept: mode === 'auto-accept',
            promptText: mode === 'auto-accept' && event.type === 'prompt'
                ? (event.defaultValue ?? '')
                : undefined,
        };
    }
    getMode(type) {
        return this.config[type];
    }
}
exports.DialogAutoPolicy = DialogAutoPolicy;
//# sourceMappingURL=DialogAutoPolicy.js.map