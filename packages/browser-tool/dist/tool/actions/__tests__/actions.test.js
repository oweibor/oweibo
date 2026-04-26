"use strict";
/**
 * Trust-gate + happy-path coverage for the three v9.5.9 actions:
 * ImportCookies, AutofillCredentials, ExtensionHitlRespond.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const AutofillCredentialsAction_js_1 = require("../AutofillCredentialsAction.js");
const ExtensionHitlRespondAction_js_1 = require("../ExtensionHitlRespondAction.js");
const ImportCookiesAction_js_1 = require("../ImportCookiesAction.js");
const PERMISSIVE = {
    permissions: [],
    allowExtensionBridge: true,
    allowCookieImport: true,
    allowAutofill: true,
};
function ctx(over = {}) {
    return {
        tenantId: 't1',
        sessionId: 's1',
        taskId: 'task1',
        securityContext: { ...PERMISSIVE, ...over },
        eventEmitter: { emit: jest.fn() },
    };
}
describe('ImportCookiesAction', () => {
    test('refuses without allowCookieImport', async () => {
        const bridge = { hasActiveSession: () => true, sendAction: jest.fn() };
        const action = new ImportCookiesAction_js_1.ImportCookiesAction(bridge);
        await expect(action.execute({ type: 'import-cookies', domain: 'x.com' }, ctx({ allowCookieImport: false }))).rejects.toThrow(/allowCookieImport/);
    });
    test('refuses when bridge has no active session', async () => {
        const bridge = { hasActiveSession: () => false, sendAction: jest.fn() };
        const action = new ImportCookiesAction_js_1.ImportCookiesAction(bridge);
        const r = await action.execute({ type: 'import-cookies', domain: 'x.com' }, ctx());
        expect(r.success).toBe(false);
        expect(r.error).toBe('NO_EXTENSION_SESSION');
    });
    test('returns NO_COOKIES_FOUND when extension yields nothing', async () => {
        const bridge = {
            hasActiveSession: () => true,
            sendAction: jest.fn().mockResolvedValue([]),
        };
        const action = new ImportCookiesAction_js_1.ImportCookiesAction(bridge);
        const r = await action.execute({ type: 'import-cookies', domain: 'x.com' }, ctx());
        expect(r.success).toBe(false);
        expect(r.error).toBe('NO_COOKIES_FOUND');
    });
    test('happy path applies cookies and emits event without leaking values', async () => {
        const cookies = [{ name: 'sid', value: 'SECRET', domain: 'x.com' }];
        const bridge = {
            hasActiveSession: () => true,
            sendAction: jest.fn()
                .mockResolvedValueOnce(cookies) // import-cookies
                .mockResolvedValueOnce({ set: 1 }), // set-cookies
        };
        const c = ctx();
        const action = new ImportCookiesAction_js_1.ImportCookiesAction(bridge);
        const r = await action.execute({ type: 'import-cookies', domain: 'x.com' }, c);
        expect(r.success).toBe(true);
        expect(JSON.stringify(r)).not.toContain('SECRET');
        expect(r.data).toEqual({ domain: 'x.com', cookieCount: 1 });
        expect(c.eventEmitter.emit).toHaveBeenCalledWith('browser-cookies-imported', expect.objectContaining({ domain: 'x.com', cookieCount: 1 }));
    });
});
describe('AutofillCredentialsAction', () => {
    test('refuses without allowAutofill', async () => {
        const bridge = {
            hasActiveSession: () => true, sendAction: jest.fn(), getActiveUrl: jest.fn(),
        };
        const action = new AutofillCredentialsAction_js_1.AutofillCredentialsAction(bridge);
        await expect(action.execute({ type: 'autofill-credentials' }, ctx({ allowAutofill: false }))).rejects.toThrow(/allowAutofill/);
    });
    test('happy path triggers bridge and reports hostname only', async () => {
        const bridge = {
            hasActiveSession: () => true,
            sendAction: jest.fn().mockResolvedValue({ triggered: true }),
            getActiveUrl: jest.fn().mockResolvedValue('https://login.example.com/path'),
        };
        const action = new AutofillCredentialsAction_js_1.AutofillCredentialsAction(bridge);
        const r = await action.execute({ type: 'autofill-credentials' }, ctx());
        expect(r.success).toBe(true);
        expect(r.data).toEqual({ host: 'login.example.com' });
        expect(bridge.sendAction).toHaveBeenCalled();
    });
});
describe('ExtensionHitlRespondAction', () => {
    test('rejects direct invocation without internal marker', async () => {
        const resolver = { resolveGate: jest.fn() };
        const action = new ExtensionHitlRespondAction_js_1.ExtensionHitlRespondAction(resolver);
        const r = await action.execute({ type: 'extension-hitl-respond', gateId: 'g1', accept: true }, ctx());
        expect(r.success).toBe(false);
        expect(r.error).toBe('FORBIDDEN_DIRECT_INVOCATION');
        expect(resolver.resolveGate).not.toHaveBeenCalled();
    });
    test('marked invocation resolves the gate', async () => {
        const resolver = { resolveGate: jest.fn().mockResolvedValue(true) };
        const action = new ExtensionHitlRespondAction_js_1.ExtensionHitlRespondAction(resolver);
        const a = ExtensionHitlRespondAction_js_1.ExtensionHitlRespondAction.markInternal({
            type: 'extension-hitl-respond', gateId: 'g1', accept: true,
        });
        const r = await action.execute(a, ctx());
        expect(r.success).toBe(true);
        expect(resolver.resolveGate).toHaveBeenCalledWith('g1', true, undefined);
    });
    test('idempotent when resolver returns false', async () => {
        const resolver = { resolveGate: jest.fn().mockResolvedValue(false) };
        const action = new ExtensionHitlRespondAction_js_1.ExtensionHitlRespondAction(resolver);
        const a = ExtensionHitlRespondAction_js_1.ExtensionHitlRespondAction.markInternal({
            type: 'extension-hitl-respond', gateId: 'g1', accept: false,
        });
        const r = await action.execute(a, ctx());
        expect(r.success).toBe(true);
        expect(r.data.idempotent).toBe(true);
    });
});
//# sourceMappingURL=actions.test.js.map