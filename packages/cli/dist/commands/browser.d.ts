/**
 * oweibo browser — CLI subcommands for the BrowserTool (v9.5.9).
 *
 * Subcommands:
 *   open <url>              Open a URL in the agent browser session (auto backend)
 *   import-cookies <domain> Import real Chrome cookies for a domain into the session
 *   autofill [selector]     Trigger Chrome password-manager autofill on the current page
 *   pair                    Pair the Oweibo Chrome extension via deep-link (one click)
 *
 * All subcommands submit a task to the pipeline API, which runs the corresponding
 * BrowserAction through BrowserTool.execute() inside the agent.
 *
 * Backend defaults to 'auto' — BrowserSessionRouter selects the optimal backend.
 */
import { Command } from 'commander';
export declare function makeBrowserCommand(): Command;
//# sourceMappingURL=browser.d.ts.map