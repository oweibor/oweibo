"use strict";
// packages/browser-tool/src/vision/BrowserVisionBridge.ts
// Active reasoning loop that drives the browser via screenshot → VLM → action cycles.
// Renamed from BrowserVisionLoop in v9.5.9; the old name is re-exported as an alias
// in BrowserVisionLoop.ts for backwards compatibility.
//
// Features:
//   • Cost gate — honours a per-call token budget; stops early if exceeded.
//   • History summarisation — compresses older turns into a summary injected into
//     the prompt via VisionPromptBuilder.earlierSummary, keeping context bounded.
//   • resumeLoop() — re-enter a suspended loop from a snapshot.
//   • VisionPromptBuilder delegates all prompt logic.
//   • ActionSelector delegates Zod validation of VLM proposals.
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserVisionBridge = void 0;
const ActionSelector_js_1 = require("./ActionSelector.js");
const VisionPromptBuilder_js_1 = require("./VisionPromptBuilder.js");
const DEFAULT_MAX_ITERATIONS = 10;
/** Summarise history once this many raw turns accumulate. */
const SUMMARISE_AFTER_TURNS = 4;
class BrowserVisionBridge {
    tool;
    llm;
    promptBuilder = new VisionPromptBuilder_js_1.VisionPromptBuilder();
    constructor(tool, llm) {
        this.tool = tool;
        this.llm = llm;
    }
    /** Run the vision loop from scratch. */
    async runLoop(goal, ctx, options = {}) {
        return this._loop(goal, ctx, [], '', 0, options);
    }
    /** Resume a previously suspended loop from a LoopSnapshot. */
    async resumeLoop(snapshot, ctx, options = {}) {
        return this._loop(snapshot.goal, ctx, snapshot.history, snapshot.earlierSummary, snapshot.iterationsDone, options);
    }
    async _loop(goal, ctx, history, earlierSummary, startIteration, options) {
        const maxIter = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
        const budget = options.tokenBudget ?? 0;
        let tokensUsed = 0;
        let lastShot = '';
        let lastInterp = '';
        for (let iter = startIteration; iter < maxIter; iter++) {
            // Cost gate
            if (budget > 0 && tokensUsed >= budget) {
                break;
            }
            // Summarise old history to keep prompt bounded
            if (history.length >= SUMMARISE_AFTER_TURNS && iter % SUMMARISE_AFTER_TURNS === 0) {
                earlierSummary = this.promptBuilder.summariseHistory(history);
                history = [];
            }
            // Screenshot
            const shot = await this.tool.execute({ type: 'screenshot', fullPage: false }, ctx);
            lastShot = shot.screenshotBase64 ?? '';
            const userPrompt = this.promptBuilder.buildUserPrompt({
                goal, iteration: iter, maxIterations: maxIter, history, earlierSummary,
            });
            const reply = await this.llm.generate({
                systemPrompt: VisionPromptBuilder_js_1.VisionPromptBuilder.SYSTEM_PROMPT,
                userPrompt,
                responseFormat: 'json',
            });
            // Rough token tracking (1 token ≈ 4 chars)
            tokensUsed += Math.ceil(((reply.output ?? '').length + userPrompt.length) / 4);
            let parsed;
            try {
                parsed = JSON.parse(reply.output ?? '{}');
            }
            catch {
                return { screenshotBase64: lastShot, interpretation: 'parse-error', taskComplete: false, confidence: 0 };
            }
            lastInterp = parsed.interpretation ?? '';
            const turn = { screenshotBase64: lastShot, interpretation: lastInterp };
            if (parsed.taskComplete) {
                return { screenshotBase64: lastShot, interpretation: lastInterp, taskComplete: true, confidence: 0.9 };
            }
            if (parsed.next !== null) {
                const sel = ActionSelector_js_1.ActionSelector.parse(parsed.next);
                if (sel.valid) {
                    turn.actionTaken = parsed.next.type ?? 'unknown';
                    await this.tool.execute(sel.action, ctx);
                }
            }
            history.push(turn);
        }
        return { screenshotBase64: lastShot, interpretation: lastInterp, taskComplete: false, confidence: 0.3 };
    }
}
exports.BrowserVisionBridge = BrowserVisionBridge;
//# sourceMappingURL=BrowserVisionBridge.js.map