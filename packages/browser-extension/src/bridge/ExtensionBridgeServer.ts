// packages/browser-extension/src/bridge/ExtensionBridgeServer.ts
// @deprecated — Legacy WebSocket transport retained for extensionBridgeMode:'websocket'.
//              Default transport in v9.5.9 is NativeMessagingBridge (stdio pipe).
//
// Extension-side WebSocket client that connects to the Node.js
// ExtensionBridgeServer running in browser-tool/src/session/. Encapsulates
// the browser WebSocket API used inside the MV3 service worker.
//
// The server side (Node.js ws package) lives in browser-tool/src/session/ExtensionBridgeServer.ts.

import type { BrowserAction, HITLGate } from '../shared/actions.js';

export type LegacyMessageHandler = (action: BrowserAction, callId: string, tabId: number) => Promise<unknown>;
export type LegacyGateHandler    = (gate: HITLGate, tabId: number) => Promise<void>;

/** @deprecated Use NativeMessagingBridge instead. */
export class ExtensionBridgeServer {
  private ws: WebSocket | null = null;
  private actionHandler: LegacyMessageHandler | null = null;
  private gateHandler:   LegacyGateHandler    | null = null;

  onAction(handler: LegacyMessageHandler): void { this.actionHandler = handler; }
  onGate(handler: LegacyGateHandler):     void { this.gateHandler   = handler; }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  connect(host: string): Promise<void> {
    if (this.isConnected()) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(host);
      ws.onopen    = () => { this.ws = ws; resolve(); };
      ws.onclose   = () => { this.ws = null; };
      ws.onerror   = (e) => { reject(new Error(`[oweibo-bridge-legacy] ws error: ${String(e)}`)); };
      ws.onmessage = (ev) => { void this.handleMessage(ev.data as string); };
    });
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  /** Send an action result back to the Node.js server. */
  sendResult(callId: string, result: unknown, error?: string): void {
    if (!this.isConnected()) return;
    this.ws!.send(JSON.stringify({ kind: 'action-result', callId, result, error }));
  }

  /** Send a gate-resolved notification back to the server. */
  sendGateResolved(gateId: string, accept: boolean): void {
    if (!this.isConnected()) return;
    this.ws!.send(JSON.stringify({ kind: 'hitl-resolve', gateId, accept }));
  }

  private async handleMessage(raw: string): Promise<void> {
    let msg: unknown;
    try { msg = JSON.parse(raw); }
    catch { console.error('[oweibo-bridge-legacy] unparseable message'); return; }

    const m = msg as Record<string, unknown>;

    if (m['kind'] === 'action' && typeof m['callId'] === 'string') {
      const callId = m['callId'] as string;
      const tabId  = (m['tabId'] as number | undefined) ?? 0;
      const action = m['action'] as BrowserAction;
      try {
        const result = await this.actionHandler?.(action, callId, tabId);
        this.sendResult(callId, result);
      } catch (e) {
        this.sendResult(callId, null, (e as Error).message);
      }
      return;
    }

    if (m['kind'] === 'hitl-open' && m['gate']) {
      const gate  = m['gate'] as HITLGate;
      const tabId = (m['tabId'] as number | undefined) ?? 0;
      try { await this.gateHandler?.(gate, tabId); }
      catch (e) { console.error('[oweibo-bridge-legacy] gate handler error:', (e as Error).message); }
      return;
    }
  }
}
