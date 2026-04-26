// packages/browser-extension/src/shared/protocol.ts
// Wire protocol shared between ExtensionBridgeServer (host) and the Chrome
// extension service worker. JSON over WebSocket. Discriminated by `kind`.

export type BridgeMessage =
  | { kind: 'pair-request';  pairCode: string; clientVersion: string }
  | { kind: 'pair-ack';      sessionToken: string; tenantId: string }
  | { kind: 'pair-fail';     reason: string }
  | { kind: 'cdp-call';      requestId: string; tabId: number; method: string; params?: Record<string, unknown> }
  | { kind: 'cdp-result';    requestId: string; result?: unknown; error?: string }
  | { kind: 'tabs-list';     requestId: string }
  | { kind: 'tabs-result';   requestId: string; tabs: { id: number; url: string; title: string }[] }
  | { kind: 'screenshot';    requestId: string; tabId: number; format: 'png' | 'jpeg' }
  | { kind: 'screenshot-result'; requestId: string; dataBase64: string }
  | { kind: 'ping' }
  | { kind: 'pong' };

export const PROTOCOL_VERSION = '1.0';
