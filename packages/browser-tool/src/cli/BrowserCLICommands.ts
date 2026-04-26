// packages/browser-tool/src/cli/BrowserCLICommands.ts
// `oweibo browser …` CLI verbs (§10.2). Each command produces a BrowserAction
// and dispatches it through BrowserTool. Argv parsing intentionally minimal —
// the parent `oweibo` CLI handles flags, this module just exposes handlers.
import type { BrowserAction, IBrowserExecutionContext } from '@oweibo/core-contracts';
import type { BrowserTool } from '../tool/BrowserTool.js';

export class BrowserCLICommands {
  constructor(private readonly tool: BrowserTool) {}

  navigate(url: string, ctx: IBrowserExecutionContext) {
    return this.tool.execute({ type: 'navigate', url } as BrowserAction, ctx);
  }
  click(selector: string, ctx: IBrowserExecutionContext) {
    return this.tool.execute({ type: 'click', selector } as BrowserAction, ctx);
  }
  type(selector: string, text: string, ctx: IBrowserExecutionContext) {
    return this.tool.execute({ type: 'type', selector, text } as BrowserAction, ctx);
  }
  screenshot(ctx: IBrowserExecutionContext) {
    return this.tool.execute({ type: 'screenshot', fullPage: true }, ctx);
  }
  snapshot(ctx: IBrowserExecutionContext) {
    return this.tool.execute({ type: 'snapshot' }, ctx);
  }
}
