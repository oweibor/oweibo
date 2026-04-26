// packages/browser-extension/src/bridge/NativeMessagingBridge.ts
// Default transport in v9.5.9. Replaces ExtensionBridgeServer WebSocket with
// Chrome-managed stdio via chrome.runtime.connectNative. Same HMAC-per-message
// authentication scheme; no port binding; no separate server process.

import type { BrowserAction } from '../shared/actions.js';

export interface NativeMessage {
  callId: string;
  /** When present: host→extension command (inbound). */
  action?: BrowserAction;
  /** Target tab for inbound actions. */
  tabId?: number;
  /** Gate payload when the host asks the extension to open a HITL surface. */
  gate?: { gateId: string; type: 'dialog' | 'vision-loop'; message: string };
  /** When present: reply to a prior extension→host call (outbound response). */
  result?: unknown;
  error?:  string;
  /** Discriminator so the extension knows whether to dispatch or resolve. */
  direction?: 'request' | 'response';
  hmac?:   string;
}

/** Handler that executes an inbound action and returns its JSON-serialisable result. */
export type InboundActionHandler = (
  action: BrowserAction,
  tabId: number,
) => Promise<unknown>;

/** Handler invoked when the host asks the extension to open a HITL gate surface. */
export type InboundGateHandler = (
  gate: { gateId: string; type: 'dialog' | 'vision-loop'; message: string },
  tabId: number,
) => Promise<void>;

type Resolver = (r: unknown) => void;
type Rejector = (err: Error) => void;

const NATIVE_HOST_NAME = 'com.oweibo.browser';

/** Subtle-crypto HMAC-SHA256 over the canonical JSON of (callId + action|result). */
async function computeHmac(key: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function verifyHmac(msg: NativeMessage, key: string): Promise<boolean> {
  if (!msg.hmac) return false;
  const { hmac: _h, ...rest } = msg;
  const expected = await computeHmac(key, JSON.stringify(rest));
  return expected === msg.hmac;
}

export class NativeMessagingBridge {
  private port: chrome.runtime.Port | null = null;
  private readonly pending = new Map<string, { resolve: Resolver; reject: Rejector }>();
  private hmacToken = '';
  private inboundAction: InboundActionHandler | null = null;
  private inboundGate:   InboundGateHandler   | null = null;

  /** Register the function that runs host-initiated actions against the browser. */
  onInboundAction(handler: InboundActionHandler): void { this.inboundAction = handler; }

  /** Register the function that opens a HITL gate surface in a tab. */
  onInboundGate(handler: InboundGateHandler): void { this.inboundGate = handler; }

  connect(hmacToken: string): void {
    if (this.port) return;
    this.hmacToken = hmacToken;
    try {
      this.port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (e) {
      console.error('[oweibo-bridge] native host connect failed:', e);
      this.port = null;
      return;
    }
    this.port.onMessage.addListener((msg: NativeMessage) => { void this.handleIncoming(msg); });
    this.port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message ?? 'disconnected';
      console.warn('[oweibo-bridge] native host disconnected:', err);
      this.failAll(new Error(err));
      this.port = null;
    });
  }

  isConnected(): boolean { return this.port !== null; }

  async sendAction(callId: string, action: BrowserAction): Promise<unknown> {
    if (!this.port) throw new Error('NativeMessagingBridge: not connected');
    const body: NativeMessage = { callId, action, direction: 'request' };
    body.hmac = await computeHmac(this.hmacToken, this.canonicalize(body));
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(callId, { resolve, reject });
      this.port!.postMessage(body);
    });
  }

  /** Post a response to an earlier inbound (host→extension) request. */
  private async sendResponse(callId: string, result: unknown, error?: string): Promise<void> {
    if (!this.port) return;
    const body: NativeMessage = { callId, result, error, direction: 'response' };
    body.hmac = await computeHmac(this.hmacToken, this.canonicalize(body));
    this.port.postMessage(body);
  }

  private canonicalize(msg: NativeMessage): string {
    // Exclude the hmac field itself — verification side recomputes over the
    // same excluded-hmac shape.
    const { hmac: _h, ...rest } = msg;
    return JSON.stringify(rest);
  }

  private async handleIncoming(msg: NativeMessage): Promise<void> {
    if (!(await verifyHmac(msg, this.hmacToken))) {
      console.error('[oweibo-bridge] HMAC mismatch; dropping message', msg.callId);
      return;
    }

    // Response to one of our outbound calls.
    if (msg.direction === 'response' || this.pending.has(msg.callId)) {
      const entry = this.pending.get(msg.callId);
      if (!entry) return;
      this.pending.delete(msg.callId);
      if (msg.error) entry.reject(new Error(msg.error));
      else           entry.resolve(msg.result);
      return;
    }

    // Inbound gate open request from host.
    if (msg.gate && typeof msg.tabId === 'number' && this.inboundGate) {
      try {
        await this.inboundGate(msg.gate, msg.tabId);
        await this.sendResponse(msg.callId, { ok: true });
      } catch (e) {
        await this.sendResponse(msg.callId, null, (e as Error).message);
      }
      return;
    }

    // Inbound action request from host.
    if (msg.action && typeof msg.tabId === 'number') {
      if (!this.inboundAction) {
        await this.sendResponse(msg.callId, null, 'no inbound action handler registered');
        return;
      }
      try {
        const result = await this.inboundAction(msg.action, msg.tabId);
        await this.sendResponse(msg.callId, result);
      } catch (e) {
        await this.sendResponse(msg.callId, null, (e as Error).message);
      }
      return;
    }

    console.warn('[oweibo-bridge] dropping unroutable message', msg.callId);
  }

  private failAll(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
}
