"use strict";
/**
 * NetworkInterceptRegistry — Playwright route handler registry for network interception.
 * (NEW v9.5.4)
 *
 * Manages intercept rules and their associated Playwright route handlers.
 * When a mock response is attached, matching requests receive the mock payload.
 * Otherwise, requests pass through normally.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NetworkInterceptRegistry = void 0;
class NetworkInterceptRegistry {
    rules = new Map();
    async addRule(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    context, rule, mock, emitter) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handler = async (route) => {
            const req = route.request();
            emitter.emit('browser-request-intercepted', {
                interceptId: rule.interceptId,
                url: req.url(),
                method: req.method(),
            });
            if (mock) {
                await route.fulfill({
                    status: mock.status ?? 200,
                    headers: mock.headers,
                    body: mock.bodyEncoding === 'base64'
                        ? Buffer.from(mock.body ?? '', 'base64')
                        : (mock.body ?? ''),
                    contentType: mock.contentType,
                });
            }
            else {
                await route.continue();
            }
        };
        await context.route(rule.urlPattern, handler);
        this.rules.set(rule.interceptId, { rule, handler, mock });
    }
    /**
     * Attach a mock response to an existing intercept rule.
     * The handler is replaced — the URL pattern route is re-registered.
     */
    async attachMock(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    context, interceptId, mock, emitter) {
        const entry = this.rules.get(interceptId);
        if (!entry)
            return false;
        // Remove old handler and re-add with mock
        await context.unroute(entry.rule.urlPattern, entry.handler);
        await this.addRule(context, entry.rule, mock, emitter);
        return true;
    }
    async removeRule(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    context, interceptId) {
        const entry = this.rules.get(interceptId);
        if (!entry)
            return false;
        try {
            await context.unroute(entry.rule.urlPattern, entry.handler);
        }
        catch { /* already unrouted */ }
        this.rules.delete(interceptId);
        return true;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clearAll(context) {
        for (const [, entry] of this.rules) {
            void context.unroute(entry.rule.urlPattern, entry.handler).catch(() => { });
        }
        this.rules.clear();
    }
    getRule(interceptId) {
        return this.rules.get(interceptId)?.rule;
    }
    listRules() {
        return [...this.rules.values()].map((e) => e.rule);
    }
}
exports.NetworkInterceptRegistry = NetworkInterceptRegistry;
//# sourceMappingURL=NetworkInterceptRegistry.js.map