// packages/browser-extension/src/bridge/ExtensionHITLBridge.ts
// Single point of entry for all HITL (human-in-the-loop) gate lifecycle events
// flowing between the pipeline and the three user-facing surfaces:
//   1. Extension popup gate card
//   2. InTabHITLOverlay (floating panel injected into the active tab)
//   3. DesktopNotificationFallback (OS notification when tab is backgrounded)
//
// Delegates gate registration and resolution to HITLSurfaceCoordinator, which
// owns the first-response-wins semantics. The popup path and badge updates are
// also managed here so background.ts stays thin.
//
// v9.5.9 — replaces the inline gate handling that was previously scattered
//           across background.ts.

import type { GateResolution, HITLGate } from '../shared/actions.js';
import type { HITLSurfaceCoordinator } from '../hitl/HITLSurfaceCoordinator.js';
import type { NativeMessagingBridge } from './NativeMessagingBridge.js';
import type { ExtensionBridgeServer } from './ExtensionBridgeServer.js';

export interface ExtensionHITLBridgeDeps {
  coordinator:    HITLSurfaceCoordinator;
  nativeBridge:   NativeMessagingBridge;
  /** Optional legacy WS bridge — present only in extensionBridgeMode:'websocket'. */
  legacyBridge?:  ExtensionBridgeServer;
}

export class ExtensionHITLBridge {
  private readonly coordinator: HITLSurfaceCoordinator;
  private readonly native:      NativeMessagingBridge;
  private readonly legacy?:     ExtensionBridgeServer;

  constructor(deps: ExtensionHITLBridgeDeps) {
    this.coordinator = deps.coordinator;
    this.native      = deps.nativeBridge;
    this.legacy      = deps.legacyBridge;
  }

  /**
   * Open a HITL gate: fan out to in-tab overlay, OS notification, and popup
   * simultaneously via HITLSurfaceCoordinator.
   */
  async openGate(gate: HITLGate, tabId: number): Promise<void> {
    await this.coordinator.open(gate, tabId);
    // Notify popup (fire-and-forget; popup may not be open)
    this.sendToPopup({ type: 'hitl-gate', gate });
  }

  /**
   * Resolve a gate — idempotent. Called by any surface (overlay, notification,
   * popup) that wins the first-response race.
   * Forwards the resolved gate back to the pipeline via whichever transport is active.
   */
  async resolveGate(resolution: GateResolution): Promise<void> {
    // coordinator.resolve() is idempotent; subsequent calls are no-ops.
    await this.coordinator.resolve(resolution);
    this.sendToPopup({ type: 'hitl-dismiss', gateId: resolution.gateId });
    this.updateBadge();
  }

  /**
   * Called by background.ts when a chrome.runtime.onMessage arrives from the
   * popup carrying a resolution.
   */
  async handlePopupResolve(gateId: string, accept: boolean, promptText?: string): Promise<void> {
    await this.resolveGate({ gateId, accept, promptText, resolvedBy: 'popup' });
  }

  /** List all pending gates for the popup to render. */
  listPending(): HITLGate[] {
    return this.coordinator.listPending();
  }

  pendingCount(): number {
    return this.coordinator.pendingCount();
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private sendToPopup(message: Record<string, unknown>): void {
    try {
      void chrome.runtime.sendMessage(message).catch(() => {
        // Popup not open — suppress the error.
      });
    } catch {
      // Service worker context may reject chrome.runtime.sendMessage if there are
      // no listeners. Silence it.
    }
  }

  private updateBadge(): void {
    const n = this.coordinator.pendingCount();
    try {
      void chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' });
      void chrome.action.setBadgeBackgroundColor({ color: '#d04a4a' });
    } catch { /* MV3 worker may be starting */ }
  }
}
