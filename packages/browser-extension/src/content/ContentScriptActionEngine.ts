// packages/browser-extension/src/content/ContentScriptActionEngine.ts
// Background-side dispatcher for the 38 DOM actions that run inside the page
// document via a content script. Produces isTrusted: true events —
// indistinguishable from real user gestures to PerimeterX, DataDome, Akamai.
//
// The 13 page-level actions listed in shared/actions.ts:DEBUGGER_ACTIONS are
// NOT handled here — callers dispatch those through DebuggerLifecycleManager.

import type { BrowserAction, ContentScriptResult } from '../shared/actions.js';

export class ContentScriptActionEngine {
  private readonly injectedTabs = new Set<number>();

  /** Inject content-script.js (idempotent) then post the action via sendMessage. */
  async dispatch(tabId: number, action: BrowserAction): Promise<ContentScriptResult> {
    try {
      await this.ensureInjected(tabId);
      const result = (await chrome.tabs.sendMessage(tabId, { __oweibo: true, action })) as
        ContentScriptResult | undefined;
      return result ?? { success: false, error: 'no response from content script' };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  private async ensureInjected(tabId: number): Promise<void> {
    if (this.injectedTabs.has(tabId)) return;
    await chrome.scripting.executeScript({
      target: { tabId },
      files:  ['content-script.js'],
    });
    this.injectedTabs.add(tabId);
  }

  /** Called by tabs.onRemoved / onUpdated to drop stale cache entries. */
  forget(tabId: number): void { this.injectedTabs.delete(tabId); }
}
