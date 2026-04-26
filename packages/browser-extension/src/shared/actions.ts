// packages/browser-extension/src/shared/actions.ts
// Local mirror of the BrowserAction discriminated union and HITLGate used
// inside the extension. Intentionally duplicated (rather than imported from
// @oweibo/core-contracts) so the extension build has no cross-package deps
// and can be bundled into a single service-worker file.
//
// Canonical sources in core-contracts/src/browser.ts — keep in sync.

export type BrowserActionType =
  | 'navigate' | 'go-back' | 'go-forward' | 'reload' | 'get-url' | 'get-title' | 'emulate-device'
  | 'click' | 'type' | 'scroll' | 'hover' | 'select' | 'check' | 'wait'
  | 'wait-for-selector' | 'submit' | 'drag-and-drop' | 'mouse-move' | 'mouse-down' | 'mouse-up'
  | 'screenshot' | 'snapshot' | 'extract'
  | 'tab-open' | 'tab-switch' | 'tab-close' | 'tabs-list'
  | 'switch-to-frame' | 'switch-to-main'
  | 'upload' | 'download' | 'move-to-upload'
  | 'clear-cookies' | 'get-cookies' | 'set-cookies'
  | 'inject-credentials' | 'import-cookies' | 'autofill-credentials'
  | 'eval' | 'key-chord' | 'handle-dialog'
  | 'intercept-request' | 'mock-response' | 'remove-intercept'
  | 'record-video-start' | 'record-video-stop' | 'har-start' | 'har-stop'
  | 'log-capture-start' | 'log-capture-stop' | 'accessibility-snapshot'
  | 'print-to-pdf' | 'load-extension' | 'share-session'
  | 'set-geolocation' | 'grant-permissions' | 'revoke-permissions'
  | 'extension-hitl-respond';

export interface BaseAction { type: BrowserActionType }

// The engine only needs to discriminate on `type` plus fields it forwards to
// the page. A loose structural type keeps the file compact while remaining
// type-safe at call sites that narrow on `type`.
export type BrowserAction = BaseAction & Record<string, unknown>;

/** 13 page-level actions that still require chrome.debugger / CDP. */
export const DEBUGGER_ACTIONS: ReadonlySet<BrowserActionType> = new Set<BrowserActionType>([
  'navigate', 'screenshot', 'eval', 'accessibility-snapshot',
  'switch-to-frame', 'handle-dialog', 'intercept-request', 'mock-response', 'remove-intercept',
  'log-capture-start', 'log-capture-stop', 'key-chord',
  'record-video-start', 'record-video-stop', 'har-start', 'har-stop',
]);

/** Cookie actions routed through the chrome.cookies API directly. */
export const COOKIE_ACTIONS: ReadonlySet<BrowserActionType> = new Set<BrowserActionType>([
  'clear-cookies', 'get-cookies', 'set-cookies', 'import-cookies',
]);

export function routeFor(type: BrowserActionType): 'debugger' | 'cookies' | 'content' {
  if (DEBUGGER_ACTIONS.has(type)) return 'debugger';
  if (COOKIE_ACTIONS.has(type))   return 'cookies';
  return 'content';
}

export interface ContentScriptResult {
  success: boolean;
  data?:   unknown;
  error?:  string;
}

export interface HITLGate {
  gateId: string;
  type: 'dialog' | 'vision-loop';
  message: string;
  dialogType?: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
}

export interface GateResolution {
  gateId: string;
  accept: boolean;
  promptText?: string;
  resolvedBy: 'overlay' | 'notification' | 'popup' | 'terminal';
}
