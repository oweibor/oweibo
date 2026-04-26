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

import type { BrowserDialogEvent, BrowserDialogPolicy, DialogAnswer } from '@oweibo/core-contracts';

export type DialogHandlingMode = 'auto-accept' | 'auto-dismiss' | 'hitl';

export interface DialogPolicyConfig {
  alert: DialogHandlingMode;
  confirm: DialogHandlingMode;
  prompt: DialogHandlingMode;
  beforeunload: DialogHandlingMode;
}

const SUPERVISED_DEFAULTS: DialogPolicyConfig = {
  alert: 'auto-dismiss',
  confirm: 'hitl',
  prompt: 'hitl',
  beforeunload: 'auto-dismiss',
};

const AUTONOMOUS_DEFAULTS: DialogPolicyConfig = {
  alert: 'auto-dismiss',
  confirm: 'auto-accept',
  prompt: 'auto-accept',
  beforeunload: 'auto-dismiss',
};

export class DialogAutoPolicy {
  constructor(
    private readonly config: DialogPolicyConfig,
  ) {}

  static forSupervised(override?: Partial<DialogPolicyConfig>): DialogAutoPolicy {
    return new DialogAutoPolicy({ ...SUPERVISED_DEFAULTS, ...override });
  }

  static forAutonomous(override?: Partial<DialogPolicyConfig>): DialogAutoPolicy {
    return new DialogAutoPolicy({ ...AUTONOMOUS_DEFAULTS, ...override });
  }

  /**
   * Returns true if the policy dictates automatic handling (not HITL).
   */
  shouldAutoHandle(event: BrowserDialogEvent): boolean {
    return this.config[event.type] !== 'hitl';
  }

  /**
   * Resolve the dialog according to the auto policy. Only call if shouldAutoHandle() === true.
   */
  resolve(event: BrowserDialogEvent): DialogAnswer {
    const mode = this.config[event.type];
    return {
      accept: mode === 'auto-accept',
      promptText: mode === 'auto-accept' && event.type === 'prompt'
        ? (event.defaultValue ?? '')
        : undefined,
    };
  }

  getMode(type: BrowserDialogEvent['type']): DialogHandlingMode {
    return this.config[type];
  }
}
