"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserCLICommands = void 0;
class BrowserCLICommands {
    tool;
    constructor(tool) {
        this.tool = tool;
    }
    navigate(url, ctx) {
        return this.tool.execute({ type: 'navigate', url }, ctx);
    }
    click(selector, ctx) {
        return this.tool.execute({ type: 'click', selector }, ctx);
    }
    type(selector, text, ctx) {
        return this.tool.execute({ type: 'type', selector, text }, ctx);
    }
    screenshot(ctx) {
        return this.tool.execute({ type: 'screenshot', fullPage: true }, ctx);
    }
    snapshot(ctx) {
        return this.tool.execute({ type: 'snapshot' }, ctx);
    }
}
exports.BrowserCLICommands = BrowserCLICommands;
//# sourceMappingURL=BrowserCLICommands.js.map