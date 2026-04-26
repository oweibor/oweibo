"use strict";
// packages/browser-tool/src/vision/VisionPromptBuilder.ts
// Builds system and user prompts for the BrowserVisionBridge reasoning loop.
// Separated from the loop class so prompt engineering can be iterated
// independently and tested without a live browser session.
Object.defineProperty(exports, "__esModule", { value: true });
exports.VisionPromptBuilder = void 0;
class VisionPromptBuilder {
    static SYSTEM_PROMPT = 'You are a browser-control vision agent. You receive a screenshot of the current ' +
        'browser state and a goal. Inspect the screenshot carefully, then decide the single ' +
        'best next BrowserAction to make progress towards the goal. ' +
        'Respond with a JSON object:\n' +
        '  { "interpretation": string, "taskComplete": boolean, "next": BrowserAction | null }\n' +
        'Use null for "next" only when taskComplete is true or the task is impossible. ' +
        'Available action types: navigate, click, type, scroll, hover, select, check, wait, ' +
        'wait-for-selector, submit, screenshot, snapshot, extract, eval, tab-open, tab-switch, ' +
        'tab-close, tabs-list, go-back, go-forward, reload, clear-cookies, get-cookies, ' +
        'set-cookies, upload, download, move-to-upload, get-url, get-title, handle-dialog, ' +
        'drag-and-drop, mouse-move, mouse-down, mouse-up, switch-to-frame, switch-to-main, ' +
        'intercept-request, mock-response, remove-intercept, record-video-start, ' +
        'record-video-stop, har-start, har-stop, emulate-device, accessibility-snapshot, ' +
        'log-capture-start, log-capture-stop, key-chord, set-geolocation, grant-permissions, ' +
        'revoke-permissions, print-to-pdf, load-extension, share-session, inject-credentials, ' +
        'import-cookies, autofill-credentials.';
    buildUserPrompt(input) {
        const lines = [
            `Goal: ${input.goal}`,
            `Iteration: ${input.iteration + 1} / ${input.maxIterations}`,
        ];
        if (input.earlierSummary) {
            lines.push(`\nEarlier session summary:\n${input.earlierSummary}`);
        }
        if (input.history.length > 0) {
            lines.push('\nRecent steps:');
            for (const turn of input.history.slice(-3)) {
                lines.push(`  • ${turn.interpretation}${turn.actionTaken ? ` → ${turn.actionTaken}` : ''}`);
            }
        }
        lines.push('\nReturn JSON: { "interpretation": string, "taskComplete": boolean, "next": BrowserAction | null }');
        return lines.join('\n');
    }
    /** Produce a compact summary of many history turns for the `earlierSummary` field. */
    summariseHistory(history) {
        if (history.length === 0)
            return '';
        const steps = history.map((t, i) => `Step ${i + 1}: ${t.interpretation}${t.actionTaken ? ` (action: ${t.actionTaken})` : ''}`);
        return steps.join('\n');
    }
}
exports.VisionPromptBuilder = VisionPromptBuilder;
//# sourceMappingURL=VisionPromptBuilder.js.map