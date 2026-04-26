// packages/browser-extension/src/hitl/InTabHITLOverlay.ts
// Background-side controller that injects hitl-overlay.js into a target tab
// on demand and posts show/dismiss messages to the overlay running inside it.
//
// The in-tab overlay is a floating panel top-right of the page with
// Accept/Dismiss buttons. Multiple concurrent gates stack vertically.
// Injection silently skips restricted tabs (chrome://, file://, webstore).

import type { HITLGate } from '../shared/actions.js';

const RESTRICTED_PREFIXES = ['chrome://', 'chrome-extension://', 'edge://', 'about:', 'file://', 'https://chromewebstore.google.com'];

export class InTabHITLOverlay {
  private readonly injected = new Set<number>();

  async show(gate: HITLGate, tabId: number): Promise<void> {
    if (!(await this.tryInject(tabId))) return;
    try {
      await chrome.tabs.sendMessage(tabId, { __oweiboHitl: 'show', gate });
    } catch (e) {
      console.warn('[oweibo-hitl] overlay show failed:', (e as Error).message);
    }
  }

  async dismiss(gateId: string, tabId: number): Promise<void> {
    try { await chrome.tabs.sendMessage(tabId, { __oweiboHitl: 'dismiss', gateId }); }
    catch { /* tab may have closed; coordinator already treats this as idempotent */ }
  }

  private async tryInject(tabId: number): Promise<boolean> {
    if (this.injected.has(tabId)) return true;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab.url || RESTRICTED_PREFIXES.some(p => tab.url!.startsWith(p))) return false;
      await chrome.scripting.executeScript({ target: { tabId }, files: ['hitl-overlay.js'] });
      this.injected.add(tabId);
      return true;
    } catch (e) {
      console.warn('[oweibo-hitl] overlay inject failed:', (e as Error).message);
      return false;
    }
  }

  forget(tabId: number): void { this.injected.delete(tabId); }
}
