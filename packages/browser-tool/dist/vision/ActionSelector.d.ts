import type { BrowserAction } from '@oweibo/core-contracts';
export interface ActionSelectionResult {
    action: BrowserAction;
    valid: true;
}
export interface ActionSelectionFailure {
    valid: false;
    reason: string;
}
export type ActionSelection = ActionSelectionResult | ActionSelectionFailure;
export declare class ActionSelector {
    /**
     * Parse and validate a raw unknown value (typically parsed JSON from a VLM)
     * against the full BrowserActionSchema discriminated union.
     */
    static parse(raw: unknown): ActionSelection;
    /** Convenience: throws if invalid, otherwise returns the action. */
    static parseOrThrow(raw: unknown): BrowserAction;
}
//# sourceMappingURL=ActionSelector.d.ts.map