"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserPromptBudget = void 0;
class BrowserPromptBudget {
    sectionKey = 'browser-observations';
    async trim(sectionText, tokenBudget, tokenizer) {
        let text = sectionText;
        let used = tokenizer.countTokens(text);
        if (used <= tokenBudget)
            return { trimmed: text, tokensUsed: used };
        // Greedy line-trim from the front (older observations first).
        const lines = text.split('\n');
        while (used > tokenBudget && lines.length > 1) {
            lines.shift();
            text = lines.join('\n');
            used = tokenizer.countTokens(text);
        }
        return { trimmed: text, tokensUsed: used };
    }
}
exports.BrowserPromptBudget = BrowserPromptBudget;
//# sourceMappingURL=BrowserPromptBudget.js.map