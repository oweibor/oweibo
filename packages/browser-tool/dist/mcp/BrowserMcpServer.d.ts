import type { IBrowserExecutionContext } from '@oweibo/core-contracts';
import type { BrowserTool } from '../tool/BrowserTool.js';
export interface McpToolCall {
    tool_name: string;
    tool_input: Record<string, unknown>;
}
export declare class BrowserMcpServer {
    private readonly tool;
    static readonly TOOL_DESCRIPTION: string;
    constructor(tool: BrowserTool);
    /** Returns the tool descriptor advertised in `tools/list`. */
    describeTool(): {
        name: string;
        description: string;
        inputSchema: unknown;
    };
    handleCall(call: McpToolCall, ctx: IBrowserExecutionContext): Promise<unknown>;
}
//# sourceMappingURL=BrowserMcpServer.d.ts.map