// packages/browser-tool/src/tool/BrowserActionSchema.ts
// Zod schema covering all 54 BrowserAction variants (v9.5.9).
// Used by ActionSelector.parse() and BrowserMcpServer to validate VLM/MCP input
// before dispatch. Discriminated union on `type` mirrors core-contracts BrowserAction.
import { z } from 'zod';

const cookie = z.object({
  name:     z.string(),
  value:    z.string(),
  domain:   z.string(),
  path:     z.string().optional(),
  expires:  z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure:   z.boolean().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
});

const deviceDescriptor = z.object({
  userAgent:         z.string(),
  viewport:          z.object({ width: z.number(), height: z.number() }),
  deviceScaleFactor: z.number().optional(),
  isMobile:          z.boolean().optional(),
  hasTouch:          z.boolean().optional(),
});

const permission = z.enum([
  'geolocation', 'notifications', 'camera', 'microphone', 'midi',
  'midi-sysex', 'background-sync', 'ambient-light-sensor', 'accelerometer',
  'gyroscope', 'magnetometer', 'accessibility-events', 'clipboard-read',
  'clipboard-write', 'payment-handler',
]);

export const BrowserActionSchema = z.discriminatedUnion('type', [
  // ── original 29 ─────────────────────────────────────────────────────────
  z.object({ type: z.literal('navigate'), url: z.string().url(), waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional() }),
  z.object({ type: z.literal('click'), selector: z.string(), button: z.enum(['left', 'right', 'middle']).optional(), clickCount: z.number().int().positive().optional() }),
  z.object({ type: z.literal('type'), selector: z.string(), text: z.string(), delay: z.number().nonnegative().optional(), clearFirst: z.boolean().optional() }),
  z.object({ type: z.literal('scroll'), selector: z.string().optional(), direction: z.enum(['up', 'down', 'left', 'right']), distance: z.number().optional() }),
  z.object({ type: z.literal('hover'), selector: z.string() }),
  z.object({ type: z.literal('select'), selector: z.string(), value: z.union([z.string(), z.array(z.string())]) }),
  z.object({ type: z.literal('check'), selector: z.string(), checked: z.boolean() }),
  z.object({ type: z.literal('wait'), ms: z.number().int().nonnegative() }),
  z.object({ type: z.literal('wait-for-selector'), selector: z.string(), state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional(), timeout: z.number().optional() }),
  z.object({ type: z.literal('submit'), selector: z.string() }),
  z.object({ type: z.literal('screenshot'), fullPage: z.boolean().optional(), element: z.string().optional() }),
  z.object({ type: z.literal('snapshot') }),
  z.object({ type: z.literal('extract'), selectors: z.array(z.object({ name: z.string(), query: z.string(), attribute: z.string().optional() })) }),
  z.object({ type: z.literal('eval'), expression: z.string() }),
  z.object({ type: z.literal('tab-open'), url: z.string().url().optional() }),
  z.object({ type: z.literal('tab-switch'), tabId: z.string() }),
  z.object({ type: z.literal('tab-close'), tabId: z.string() }),
  z.object({ type: z.literal('tabs-list') }),
  z.object({ type: z.literal('go-back') }),
  z.object({ type: z.literal('go-forward') }),
  z.object({ type: z.literal('reload') }),
  z.object({ type: z.literal('clear-cookies'), domain: z.string().optional() }),
  z.object({ type: z.literal('get-cookies'), domain: z.string().optional() }),
  z.object({ type: z.literal('set-cookies'), cookies: z.array(cookie) }),
  z.object({ type: z.literal('upload'), selector: z.string(), filePath: z.string() }),
  z.object({ type: z.literal('download'), url: z.string().url(), filename: z.string().optional() }),
  z.object({ type: z.literal('get-url') }),
  z.object({ type: z.literal('get-title') }),
  z.object({ type: z.literal('move-to-upload'), sourcePath: z.string(), filename: z.string().optional() }),

  // ── v9.5.4 additions ────────────────────────────────────────────────────
  z.object({ type: z.literal('handle-dialog'), accept: z.boolean(), promptText: z.string().optional() }),
  z.object({
    type:           z.literal('drag-and-drop'),
    sourceSelector: z.string(),
    targetSelector: z.string(),
    sourceOffset:   z.object({ x: z.number(), y: z.number() }).optional(),
    targetOffset:   z.object({ x: z.number(), y: z.number() }).optional(),
    steps:          z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal('mouse-move'), x: z.number(), y: z.number() }),
  z.object({ type: z.literal('mouse-down'), button: z.enum(['left', 'right', 'middle']).optional() }),
  z.object({ type: z.literal('mouse-up'),   button: z.enum(['left', 'right', 'middle']).optional() }),
  z.object({ type: z.literal('switch-to-frame'), selector: z.string() }),
  z.object({ type: z.literal('switch-to-main') }),
  z.object({ type: z.literal('intercept-request'), urlPattern: z.string(), method: z.string().optional(), interceptId: z.string().optional() }),
  z.object({
    type:         z.literal('mock-response'),
    interceptId:  z.string(),
    status:       z.number().int().optional(),
    headers:      z.record(z.string()).optional(),
    body:         z.string().optional(),
    bodyEncoding: z.enum(['utf8', 'base64']).optional(),
    contentType:  z.string().optional(),
  }),
  z.object({ type: z.literal('remove-intercept'), interceptId: z.string() }),
  z.object({ type: z.literal('record-video-start'), width: z.number().optional(), height: z.number().optional() }),
  z.object({ type: z.literal('record-video-stop') }),
  z.object({ type: z.literal('har-start'), urlFilter: z.string().optional(), omitContent: z.boolean().optional() }),
  z.object({ type: z.literal('har-stop') }),
  z.object({ type: z.literal('emulate-device'), deviceName: z.string().optional(), customDescriptor: deviceDescriptor.optional() }),
  z.object({ type: z.literal('accessibility-snapshot'), rootSelector: z.string().optional(), maxDepth: z.number().int().positive().optional() }),
  z.object({ type: z.literal('log-capture-start') }),
  z.object({ type: z.literal('log-capture-stop') }),

  // ── v9.5.5 additions ────────────────────────────────────────────────────
  z.object({ type: z.literal('key-chord'), keys: z.string(), count: z.number().int().positive().optional() }),
  z.object({ type: z.literal('set-geolocation'), latitude: z.number(), longitude: z.number(), accuracy: z.number().optional() }),
  z.object({ type: z.literal('grant-permissions'), permissions: z.array(permission), origin: z.string().optional() }),
  z.object({ type: z.literal('revoke-permissions') }),
  z.object({
    type:            z.literal('print-to-pdf'),
    filename:        z.string().optional(),
    format:          z.enum(['A4', 'Letter']).optional(),
    landscape:       z.boolean().optional(),
    printBackground: z.boolean().optional(),
    margin:          z.object({ top: z.string().optional(), bottom: z.string().optional(), left: z.string().optional(), right: z.string().optional() }).optional(),
  }),
  z.object({ type: z.literal('load-extension'), extensionId: z.string() }),
  z.object({ type: z.literal('share-session'), ttlSeconds: z.number().int().positive().optional() }),

  // ── v9.5.6 additions ────────────────────────────────────────────────────
  z.object({
    type:             z.literal('inject-credentials'),
    serviceId:        z.string(),
    submitAfterFill:  z.boolean().optional(),
    usernameSelector: z.string().optional(),
    passwordSelector: z.string().optional(),
  }),

  // ── v9.5.9 additions ────────────────────────────────────────────────────
  z.object({
    type:            z.literal('import-cookies'),
    /** Hostname or full domain (e.g. "github.com") to import cookies for. */
    domain:          z.string(),
  }),
  z.object({
    type:            z.literal('autofill-credentials'),
    /** CSS selector of the username/email input field to focus first. */
    usernameSelector: z.string().optional(),
    /** If true, dispatch Enter after Chrome fills the form. */
    submitAfterFill:  z.boolean().optional(),
  }),
  z.object({
    type:       z.literal('extension-hitl-respond'),
    /** Gate UUID issued by HITLSurfaceCoordinator. */
    gateId:     z.string(),
    /** true = user approved the action; false = user dismissed/denied. */
    accept:     z.boolean(),
    /** Optional free-text prompt response (prompt-type gates only). */
    promptText: z.string().optional(),
  }),
]);

export type BrowserActionInput = z.infer<typeof BrowserActionSchema>;
