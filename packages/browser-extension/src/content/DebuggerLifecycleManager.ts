// packages/browser-extension/src/content/DebuggerLifecycleManager.ts
// Lazy chrome.debugger attach/detach. Default policy is 'lazy': attach just
// before each page-level action, detach immediately after. For content-script-
// only flows chrome.debugger is never touched, so the yellow banner is absent.

export type DebuggerPolicy = 'persistent' | 'lazy';

const DEBUGGER_VERSION = '1.3';

export class DebuggerLifecycleManager {
  private attachedTabs = new Set<number>();

  constructor(public policy: DebuggerPolicy = 'lazy') {}

  /** Run `fn` with chrome.debugger attached to `tabId` per the active policy. */
  async withDebugger<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
    if (this.policy === 'persistent') {
      await this.ensureAttached(tabId);
      return fn();
    }
    await this.ensureAttached(tabId);
    try { return await fn(); }
    finally { await this.detach(tabId); }
  }

  async ensureAttached(tabId: number): Promise<void> {
    if (this.attachedTabs.has(tabId)) return;
    await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
    this.attachedTabs.add(tabId);
  }

  async detach(tabId: number): Promise<void> {
    if (!this.attachedTabs.has(tabId)) return;
    try { await chrome.debugger.detach({ tabId }); }
    catch (e) { console.warn('[oweibo-debugger] detach failed:', (e as Error).message); }
    this.attachedTabs.delete(tabId);
  }

  async detachAll(): Promise<void> {
    await Promise.allSettled([...this.attachedTabs].map(id => this.detach(id)));
  }
}
