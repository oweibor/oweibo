// packages/browser-tool/src/mcp/BrowserMcpServer.ts
// MCP-server facade (§10.5) — exposes BrowserTool as a tool to MCP clients.
// Each `tools/call` is validated through BrowserActionSchema before dispatch.
import type { BrowserAction, IBrowserExecutionContext } from '@oweibo/core-contracts';
import type { BrowserTool } from '../tool/BrowserTool.js';
import { BrowserActionSchema } from '../tool/BrowserActionSchema.js';

export interface McpToolCall {
  tool_name:  string;
  tool_input: Record<string, unknown>;
}

export class BrowserMcpServer {
  static readonly TOOL_DESCRIPTION =
    'Full Chromium browser. 54 actions: navigate, click, type, scroll, hover, ' +
    'snapshot, screenshot, tabs, cookies, files, dialogs, intercepts, video/HAR, ' +
    'PDF, geolocation, permissions, frame switching, credentials, import-cookies, ' +
    'autofill-credentials, extension-hitl-respond, and more.';

  constructor(private readonly tool: BrowserTool) {}

  /** Returns the tool descriptor advertised in `tools/list`. */
  describeTool(): { name: string; description: string; inputSchema: unknown } {
    return {
      name:        'browser',
      description: BrowserMcpServer.TOOL_DESCRIPTION,
      inputSchema: { type: 'object', description: 'See BrowserAction discriminated union.' },
    };
  }

  async handleCall(call: McpToolCall, ctx: IBrowserExecutionContext): Promise<unknown> {
    const candidate = { type: call.tool_name, ...call.tool_input };
    const parsed = BrowserActionSchema.safeParse(candidate);
    if (!parsed.success) {
      return { isError: true, content: [{ type: 'text', text: `invalid action: ${parsed.error.message}` }] };
    }
    const result = await this.tool.execute(parsed.data as BrowserAction, ctx);
    return { isError: !result.success, content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
}
