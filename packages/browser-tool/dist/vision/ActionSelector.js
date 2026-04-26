"use strict";
// packages/browser-tool/src/vision/ActionSelector.ts
// Validates and selects the next BrowserAction from raw VLM JSON output.
// Wraps BrowserActionSchema so callers (BrowserVisionBridge, BrowserMcpServer)
// work with a typed result rather than calling Zod directly.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActionSelector = void 0;
const BrowserActionSchema_js_1 = require("../tool/BrowserActionSchema.js");
class ActionSelector {
    /**
     * Parse and validate a raw unknown value (typically parsed JSON from a VLM)
     * against the full BrowserActionSchema discriminated union.
     */
    static parse(raw) {
        const result = BrowserActionSchema_js_1.BrowserActionSchema.safeParse(raw);
        if (result.success) {
            return { valid: true, action: result.data };
        }
        return {
            valid: false,
            reason: result.error.issues
                .map(i => `${i.path.join('.')}: ${i.message}`)
                .join('; '),
        };
    }
    /** Convenience: throws if invalid, otherwise returns the action. */
    static parseOrThrow(raw) {
        const sel = ActionSelector.parse(raw);
        if (!sel.valid)
            throw new Error(`ActionSelector: invalid action — ${sel.reason}`);
        return sel.action;
    }
}
exports.ActionSelector = ActionSelector;
//# sourceMappingURL=ActionSelector.js.map