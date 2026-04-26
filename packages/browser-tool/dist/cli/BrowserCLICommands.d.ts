import type { IBrowserExecutionContext } from '@oweibo/core-contracts';
import type { BrowserTool } from '../tool/BrowserTool.js';
export declare class BrowserCLICommands {
    private readonly tool;
    constructor(tool: BrowserTool);
    navigate(url: string, ctx: IBrowserExecutionContext): Promise<import("@oweibo/core-contracts").BrowserActionResult>;
    click(selector: string, ctx: IBrowserExecutionContext): Promise<import("@oweibo/core-contracts").BrowserActionResult>;
    type(selector: string, text: string, ctx: IBrowserExecutionContext): Promise<import("@oweibo/core-contracts").BrowserActionResult>;
    screenshot(ctx: IBrowserExecutionContext): Promise<import("@oweibo/core-contracts").BrowserActionResult>;
    snapshot(ctx: IBrowserExecutionContext): Promise<import("@oweibo/core-contracts").BrowserActionResult>;
}
//# sourceMappingURL=BrowserCLICommands.d.ts.map