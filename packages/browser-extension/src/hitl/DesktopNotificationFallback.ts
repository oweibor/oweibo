// packages/browser-extension/src/hitl/DesktopNotificationFallback.ts
// Fires an OS notification for a gate when its tab is backgrounded. If the
// user is looking at the tab, the in-tab overlay is sufficient and we skip.
// Buttons on the notification resolve the gate directly (accept / dismiss);
// clicking the body focuses the tab so the overlay becomes visible.

import type { GateResolution, HITLGate } from '../shared/actions.js';

type ResolveHandler = (r: GateResolution) => void;

export class DesktopNotificationFallback {
  private readonly shown = new Map<string, { gateId: string; tabId: number }>();
  private resolver: ResolveHandler | null = null;
  private wired = false;

  onResolve(handler: ResolveHandler): void {
    this.resolver = handler;
    if (this.wired) return;
    this.wired = true;

    chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
      const entry = this.shown.get(notificationId);
      if (!entry) return;
      this.resolver?.({
        gateId: entry.gateId,
        accept: buttonIndex === 0,
        resolvedBy: 'notification',
      });
    });

    chrome.notifications.onClicked.addListener((notificationId) => {
      const entry = this.shown.get(notificationId);
      if (!entry) return;
      void chrome.tabs.update(entry.tabId, { active: true });
    });
  }

  async show(gate: HITLGate, tabId: number): Promise<void> {
    try {
      const tab = await chrome.tabs.get(tabId);
      const win = tab.windowId != null ? await chrome.windows.get(tab.windowId) : undefined;
      if (tab.active && win?.focused) return;  // foregrounded — overlay is enough

      const notificationId = `oweibo-hitl-${gate.gateId}`;
      await chrome.notifications.create(notificationId, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Oweibo needs your approval',
        message: gate.message,
        buttons: [{ title: 'Accept' }, { title: 'Dismiss' }],
        requireInteraction: true,
        priority: 2,
      });
      this.shown.set(notificationId, { gateId: gate.gateId, tabId });
    } catch (e) {
      console.warn('[oweibo-hitl] notification show failed:', (e as Error).message);
    }
  }

  async dismiss(gateId: string): Promise<void> {
    const id = `oweibo-hitl-${gateId}`;
    try { await chrome.notifications.clear(id); } catch { /* no-op */ }
    this.shown.delete(id);
  }
}
