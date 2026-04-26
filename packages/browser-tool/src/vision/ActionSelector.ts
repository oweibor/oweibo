// packages/browser-tool/src/vision/ActionSelector.ts
// Validates and selects the next BrowserAction from raw VLM JSON output.
// Wraps BrowserActionSchema so callers (BrowserVisionBridge, BrowserMcpServer)
// work with a typed result rather than calling Zod directly.

import type { BrowserAction } from '@oweibo/core-contracts';
import { BrowserActionSchema } from '../tool/BrowserActionSchema.js';

export interface ActionSelectionResult {
  action: BrowserAction;
  valid: true;
}

export interface ActionSelectionFailure {
  valid: false;
  reason: string;
}

export type ActionSelection = ActionSelectionResult | ActionSelectionFailure;

export class ActionSelector {
  /**
   * Parse and validate a raw unknown value (typically parsed JSON from a VLM)
   * against the full BrowserActionSchema discriminated union.
   */
  static parse(raw: unknown): ActionSelection {
    const result = BrowserActionSchema.safeParse(raw);
    if (result.success) {
      return { valid: true, action: result.data as BrowserAction };
    }
    return {
      valid: false,
      reason: result.error.issues
        .map(i => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    };
  }

  /** Convenience: throws if invalid, otherwise returns the action. */
  static parseOrThrow(raw: unknown): BrowserAction {
    const sel = ActionSelector.parse(raw);
    if (!sel.valid) throw new Error(`ActionSelector: invalid action — ${sel.reason}`);
    return sel.action;
  }
}
