/**
 * IBrowserContentPolicy — interface for URL and action policy enforcement.
 * Implemented by BrowserContentPolicy in packages/browser-tool/src/policy/.
 */
import type { BrowserAction, IBrowserExecutionContext } from '@oweibo/core-contracts';
export interface IBrowserContentPolicy {
    /**
     * Check whether the given action is permitted under the current execution context.
     * Throws BrowserPolicyViolationError if the action is blocked.
     */
    check(action: BrowserAction, context: IBrowserExecutionContext): Promise<void>;
    /**
     * Check a URL specifically (used before navigate and download).
     * Throws BrowserPolicyViolationError if the URL is blocked.
     */
    checkUrl(url: string, context: IBrowserExecutionContext): Promise<void>;
}
//# sourceMappingURL=IBrowserContentPolicy.d.ts.map