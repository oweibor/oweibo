"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserMcpServer = void 0;
const BrowserActionSchema_js_1 = require("../tool/BrowserActionSchema.js");
class BrowserMcpServer {
    tool;
    static TOOL_DESCRIPTION = 'Full Chromium browser. 54 actions: navigate, click, type, scroll, hover, ' +
        'snapshot, screenshot, tabs, cookies, files, dialogs, intercepts, video/HAR, ' +
        'PDF, geolocation, permissions, frame switching, credentials, import-cookies, ' +
        'autofill-credentials, extension-hitl-respond, and more.';
    constructor(tool) {
        this.tool = tool;
    }
    /** Returns the tool descriptor advertised in `tools/list`. */
    describeTool() {
        return {
            name: 'browser',
            description: BrowserMcpServer.TOOL_DESCRIPTION,
            inputSchema: { type: 'object', description: 'See BrowserAction discriminated union.' },
        };
    }
    async handleCall(call, ctx) {
        const candidate = { type: call.tool_name, ...call.tool_input };
        const parsed = BrowserActionSchema_js_1.BrowserActionSchema.safeParse(candidate);
        if (!parsed.success) {
            return { isError: true, content: [{ type: 'text', text: `invalid action: ${parsed.error.message}` }] };
        }
        const result = await this.tool.execute(parsed.data, ctx);
        return { isError: !result.success, content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
}
exports.BrowserMcpServer = BrowserMcpServer;
//# sourceMappingURL=BrowserMcpServer.js.map