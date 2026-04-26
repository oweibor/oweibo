/**
 * NetworkInterceptRegistry — Playwright route handler registry for network interception.
 * (NEW v9.5.4)
 *
 * Manages intercept rules and their associated Playwright route handlers.
 * When a mock response is attached, matching requests receive the mock payload.
 * Otherwise, requests pass through normally.
 */
import type { BrowserInterceptRule, BrowserMockResponse, IBrowserEventEmitter } from '@oweibo/core-contracts';
export declare class NetworkInterceptRegistry {
    private readonly rules;
    addRule(context: any, rule: BrowserInterceptRule, mock: BrowserMockResponse | null, emitter: IBrowserEventEmitter): Promise<void>;
    /**
     * Attach a mock response to an existing intercept rule.
     * The handler is replaced — the URL pattern route is re-registered.
     */
    attachMock(context: any, interceptId: string, mock: BrowserMockResponse, emitter: IBrowserEventEmitter): Promise<boolean>;
    removeRule(context: any, interceptId: string): Promise<boolean>;
    clearAll(context: any): void;
    getRule(interceptId: string): BrowserInterceptRule | undefined;
    listRules(): BrowserInterceptRule[];
}
//# sourceMappingURL=NetworkInterceptRegistry.d.ts.map