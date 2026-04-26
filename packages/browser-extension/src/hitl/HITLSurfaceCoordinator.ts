// packages/browser-extension/src/hitl/HITLSurfaceCoordinator.ts
// Single gate lifecycle authority for the unified three-surface HITL system.
// All surfaces (in-tab overlay, OS notification, popup) register through it.
// First response wins; all others dismiss instantly. Idempotent by gateId.

import type { GateResolution, HITLGate } from '../shared/actions.js';

import type { DesktopNotificationFallback } from './DesktopNotificationFallback.js';
import type { InTabHITLOverlay } from './InTabHITLOverlay.js';

export interface ResolvedGateSink {
  /** Forwards a resolved gate back to the pipeline (typically via the bridge). */
  onResolved(resolution: GateResolution): Promise<void>;
}

export class HITLSurfaceCoordinator {
  private readonly gates = new Map<string, { gate: HITLGate; tabId: number; resolved: boolean }>();

  constructor(
    private readonly overlay:      InTabHITLOverlay,
    private readonly notification: DesktopNotificationFallback,
    private readonly sink:         ResolvedGateSink,
  ) {
    this.notification.onResolve((r) => void this.resolve(r));
  }

  pendingCount(): number {
    let n = 0;
    for (const g of this.gates.values()) if (!g.resolved) n++;
    return n;
  }

  listPending(): HITLGate[] {
    return [...this.gates.values()].filter(g => !g.resolved).map(g => g.gate);
  }

  async open(gate: HITLGate, tabId: number): Promise<void> {
    if (this.gates.has(gate.gateId)) return;
    this.gates.set(gate.gateId, { gate, tabId, resolved: false });
    await Promise.allSettled([
      this.overlay.show(gate, tabId),
      this.notification.show(gate, tabId),
    ]);
    this.updateBadge();
  }

  async resolve(resolution: GateResolution): Promise<void> {
    const entry = this.gates.get(resolution.gateId);
    if (!entry || entry.resolved) return;           // idempotent
    entry.resolved = true;
    this.gates.delete(resolution.gateId);

    await Promise.allSettled([
      this.overlay.dismiss(resolution.gateId, entry.tabId),
      this.notification.dismiss(resolution.gateId),
      this.sink.onResolved(resolution),
    ]);
    this.updateBadge();
  }

  private updateBadge(): void {
    const n = this.pendingCount();
    try {
      void chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' });
      void chrome.action.setBadgeBackgroundColor({ color: '#d04a4a' });
    } catch { /* MV3 worker may be starting; ignore */ }
  }
}
