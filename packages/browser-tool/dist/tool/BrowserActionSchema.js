"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserActionSchema = void 0;
// packages/browser-tool/src/tool/BrowserActionSchema.ts
// Zod schema covering all 54 BrowserAction variants (v9.5.9).
// Used by ActionSelector.parse() and BrowserMcpServer to validate VLM/MCP input
// before dispatch. Discriminated union on `type` mirrors core-contracts BrowserAction.
const zod_1 = require("zod");
const cookie = zod_1.z.object({
    name: zod_1.z.string(),
    value: zod_1.z.string(),
    domain: zod_1.z.string(),
    path: zod_1.z.string().optional(),
    expires: zod_1.z.number().optional(),
    httpOnly: zod_1.z.boolean().optional(),
    secure: zod_1.z.boolean().optional(),
    sameSite: zod_1.z.enum(['Strict', 'Lax', 'None']).optional(),
});
const deviceDescriptor = zod_1.z.object({
    userAgent: zod_1.z.string(),
    viewport: zod_1.z.object({ width: zod_1.z.number(), height: zod_1.z.number() }),
    deviceScaleFactor: zod_1.z.number().optional(),
    isMobile: zod_1.z.boolean().optional(),
    hasTouch: zod_1.z.boolean().optional(),
});
const permission = zod_1.z.enum([
    'geolocation', 'notifications', 'camera', 'microphone', 'midi',
    'midi-sysex', 'background-sync', 'ambient-light-sensor', 'accelerometer',
    'gyroscope', 'magnetometer', 'accessibility-events', 'clipboard-read',
    'clipboard-write', 'payment-handler',
]);
exports.BrowserActionSchema = zod_1.z.discriminatedUnion('type', [
    // ── original 29 ─────────────────────────────────────────────────────────
    zod_1.z.object({ type: zod_1.z.literal('navigate'), url: zod_1.z.string().url(), waitUntil: zod_1.z.enum(['load', 'domcontentloaded', 'networkidle']).optional() }),
    zod_1.z.object({ type: zod_1.z.literal('click'), selector: zod_1.z.string(), button: zod_1.z.enum(['left', 'right', 'middle']).optional(), clickCount: zod_1.z.number().int().positive().optional() }),
    zod_1.z.object({ type: zod_1.z.literal('type'), selector: zod_1.z.string(), text: zod_1.z.string(), delay: zod_1.z.number().nonnegative().optional(), clearFirst: zod_1.z.boolean().optional() }),
    zod_1.z.object({ type: zod_1.z.literal('scroll'), selector: zod_1.z.string().optional(), direction: zod_1.z.enum(['up', 'down', 'left', 'right']), distance: zod_1.z.number().optional() }),
    zod_1.z.object({ type: zod_1.z.literal('hover'), selector: zod_1.z.string() }),
    zod_1.z.object({ type: zod_1.z.literal('select'), selector: zod_1.z.string(), value: zod_1.z.union([zod_1.z.string(), zod_1.z.array(zod_1.z.string())]) }),
    zod_1.z.object({ type: zod_1.z.literal('check'), selector: zod_1.z.string(), checked: zod_1.z.boolean() }),
    zod_1.z.object({ type: zod_1.z.literal('wait'), ms: zod_1.z.number().int().nonnegative() }),
    zod_1.z.object({ type: zod_1.z.literal('wait-for-selector'), selector: zod_1.z.string(), state: zod_1.z.enum(['visible', 'hidden', 'attached', 'detached']).optional(), timeout: zod_1.z.number().optional() }),
    zod_1.z.object({ type: zod_1.z.literal('submit'), selector: zod_1.z.string() }),
    zod_1.z.object({ type: zod_1.z.literal('screenshot'), fullPage: zod_1.z.boolean().optional(), element: zod_1.z.string().optional() }),
    zod_1.z.object({ type: zod_1.z.literal('snapshot') }),
    zod_1.z.object({ type: zod_1.z.literal('extract'), selectors: zod_1.z.array(zod_1.z.object({ name: zod_1.z.string(), query: zod_1.z.string(), attribute: zod_1.z.string().optional() })) }),
    zod_1.z.object({ type: zod_1.z.literal('eval'), expression: zod_1.z.string() }),
    zod_1.z.object({ type: zod_1.z.literal('tab-open'), url: zod_1.z.string().url().optional() }),
    zod_1.z.object({ type: zod_1.z.literal('tab-switch'), tabId: zod_1.z.string() }),
    zod_1.z.object({ type: zod_1.z.literal('tab-close'), tabId: zod_1.z.string() }),
    zod_1.z.object({ type: zod_1.z.literal('tabs-list') }),
    zod_1.z.object({ type: zod_1.z.literal('go-back') }),
    zod_1.z.object({ type: zod_1.z.literal('go-forward') }),
    zod_1.z.object({ type: zod_1.z.literal('reload') }),
    zod_1.z.object({ type: zod_1.z.literal('clear-cookies'), domain: zod_1.z.string().optional() }),
    zod_1.z.object({ type: zod_1.z.literal('get-cookies'), domain: zod_1.z.string().optional() }),
    zod_1.z.object({ type: zod_1.z.literal('set-cookies'), cookies: zod_1.z.array(cookie) }),
    zod_1.z.object({ type: zod_1.z.literal('upload'), selector: zod_1.z.string(), filePath: zod_1.z.string() }),
    zod_1.z.object({ type: zod_1.z.literal('download'), url: zod_1.z.string().url(), filename: zod_1.z.string().optional() }),
    zod_1.z.object({ type: zod_1.z.literal('get-url') }),
    zod_1.z.object({ type: zod_1.z.literal('get-title') }),
    zod_1.z.object({ type: zod_1.z.literal('move-to-upload'), sourcePath: zod_1.z.string(), filename: zod_1.z.string().optional() }),
    // ── v9.5.4 additions ────────────────────────────────────────────────────
    zod_1.z.object({ type: zod_1.z.literal('handle-dialog'), accept: zod_1.z.boolean(), promptText: zod_1.z.string().optional() }),
    zod_1.z.object({
        type: zod_1.z.literal('drag-and-drop'),
        sourceSelector: zod_1.z.string(),
        targetSelector: zod_1.z.string(),
        sourceOffset: zod_1.z.object({ x: zod_1.z.number(), y: zod_1.z.number() }).optional(),
        targetOffset: zod_1.z.object({ x: zod_1.z.number(), y: zod_1.z.number() }).optional(),
        steps: zod_1.z.number().int().positive().optional(),
    }),
    zod_1.z.object({ type: zod_1.z.literal('mouse-move'), x: zod_1.z.number(), y: zod_1.z.number() }),
    zod_1.z.object({ type: zod_1.z.literal('mouse-down'), button: zod_1.z.enum(['left', 'right', 'middle']).optional() }),
    zod_1.z.object({ type: zod_1.z.literal('mouse-up'), button: zod_1.z.enum(['left', 'right', 'middle']).optional() }),
    zod_1.z.object({ type: zod_1.z.literal('switch-to-frame'), selector: zod_1.z.string() }),
    zod_1.z.object({ type: zod_1.z.literal('switch-to-main') }),
    zod_1.z.object({ type: zod_1.z.literal('intercept-request'), urlPattern: zod_1.z.string(), method: zod_1.z.string().optional(), interceptId: zod_1.z.string().optional() }),
    zod_1.z.object({
        type: zod_1.z.literal('mock-response'),
        interceptId: zod_1.z.string(),
        status: zod_1.z.number().int().optional(),
        headers: zod_1.z.record(zod_1.z.string()).optional(),
        body: zod_1.z.string().optional(),
        bodyEncoding: zod_1.z.enum(['utf8', 'base64']).optional(),
        contentType: zod_1.z.string().optional(),
    }),
    zod_1.z.object({ type: zod_1.z.literal('remove-intercept'), interceptId: zod_1.z.string() }),
    zod_1.z.object({ type: zod_1.z.literal('record-video-start'), width: zod_1.z.number().optional(), height: zod_1.z.number().optional() }),
    zod_1.z.object({ type: zod_1.z.literal('record-video-stop') }),
    zod_1.z.object({ type: zod_1.z.literal('har-start'), urlFilter: zod_1.z.string().optional(), omitContent: zod_1.z.boolean().optional() }),
    zod_1.z.object({ type: zod_1.z.literal('har-stop') }),
    zod_1.z.object({ type: zod_1.z.literal('emulate-device'), deviceName: zod_1.z.string().optional(), customDescriptor: deviceDescriptor.optional() }),
    zod_1.z.object({ type: zod_1.z.literal('accessibility-snapshot'), rootSelector: zod_1.z.string().optional(), maxDepth: zod_1.z.number().int().positive().optional() }),
    zod_1.z.object({ type: zod_1.z.literal('log-capture-start') }),
    zod_1.z.object({ type: zod_1.z.literal('log-capture-stop') }),
    // ── v9.5.5 additions ────────────────────────────────────────────────────
    zod_1.z.object({ type: zod_1.z.literal('key-chord'), keys: zod_1.z.string(), count: zod_1.z.number().int().positive().optional() }),
    zod_1.z.object({ type: zod_1.z.literal('set-geolocation'), latitude: zod_1.z.number(), longitude: zod_1.z.number(), accuracy: zod_1.z.number().optional() }),
    zod_1.z.object({ type: zod_1.z.literal('grant-permissions'), permissions: zod_1.z.array(permission), origin: zod_1.z.string().optional() }),
    zod_1.z.object({ type: zod_1.z.literal('revoke-permissions') }),
    zod_1.z.object({
        type: zod_1.z.literal('print-to-pdf'),
        filename: zod_1.z.string().optional(),
        format: zod_1.z.enum(['A4', 'Letter']).optional(),
        landscape: zod_1.z.boolean().optional(),
        printBackground: zod_1.z.boolean().optional(),
        margin: zod_1.z.object({ top: zod_1.z.string().optional(), bottom: zod_1.z.string().optional(), left: zod_1.z.string().optional(), right: zod_1.z.string().optional() }).optional(),
    }),
    zod_1.z.object({ type: zod_1.z.literal('load-extension'), extensionId: zod_1.z.string() }),
    zod_1.z.object({ type: zod_1.z.literal('share-session'), ttlSeconds: zod_1.z.number().int().positive().optional() }),
    // ── v9.5.6 additions ────────────────────────────────────────────────────
    zod_1.z.object({
        type: zod_1.z.literal('inject-credentials'),
        serviceId: zod_1.z.string(),
        submitAfterFill: zod_1.z.boolean().optional(),
        usernameSelector: zod_1.z.string().optional(),
        passwordSelector: zod_1.z.string().optional(),
    }),
    // ── v9.5.9 additions ────────────────────────────────────────────────────
    zod_1.z.object({
        type: zod_1.z.literal('import-cookies'),
        /** Hostname or full domain (e.g. "github.com") to import cookies for. */
        domain: zod_1.z.string(),
    }),
    zod_1.z.object({
        type: zod_1.z.literal('autofill-credentials'),
        /** CSS selector of the username/email input field to focus first. */
        usernameSelector: zod_1.z.string().optional(),
        /** If true, dispatch Enter after Chrome fills the form. */
        submitAfterFill: zod_1.z.boolean().optional(),
    }),
    zod_1.z.object({
        type: zod_1.z.literal('extension-hitl-respond'),
        /** Gate UUID issued by HITLSurfaceCoordinator. */
        gateId: zod_1.z.string(),
        /** true = user approved the action; false = user dismissed/denied. */
        accept: zod_1.z.boolean(),
        /** Optional free-text prompt response (prompt-type gates only). */
        promptText: zod_1.z.string().optional(),
    }),
]);
//# sourceMappingURL=BrowserActionSchema.js.map