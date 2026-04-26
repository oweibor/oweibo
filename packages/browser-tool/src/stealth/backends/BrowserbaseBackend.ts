// packages/browser-tool/src/stealth/backends/BrowserbaseBackend.ts
// Browserbase remote browser backend (§5.2). Connect via CDP using Browserbase session URL.
import { chromium } from 'playwright-extra';
import type { BrowserContext } from 'playwright';
import type { BrowserSessionConfig } from '@oweibo/core-contracts';
import type { IBrowserBackend, BrowserBackendType } from '../../contracts/IBrowserBackend.js';

export class BrowserbaseBackend implements IBrowserBackend {
  readonly type: BrowserBackendType = 'browserbase';

  constructor(private readonly apiKey: string) {}

  async launchContext(config: BrowserSessionConfig): Promise<unknown> {
    const projectId = config.browserbaseProjectId;
    if (!projectId) throw new Error('[BrowserbaseBackend] browserbaseProjectId required');

    const res = await fetch('https://api.browserbase.com/v1/sessions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-BB-API-Key': this.apiKey },
      body:    JSON.stringify({ projectId }),
    });
    if (!res.ok) throw new Error(`[BrowserbaseBackend] HTTP ${res.status}`);
    const session = await res.json() as { connectUrl: string };

    const browser = await chromium.connectOverCDP(session.connectUrl);
    const contexts = browser.contexts();
    return contexts[0] ?? await browser.newContext();
  }

  async closeContext(context: unknown): Promise<void> {
    const ctx = context as BrowserContext;
    const browser = ctx.browser();
    if (browser) await browser.close().catch(() => {});
  }

  async captureStorageState(context: unknown): Promise<string | null> {
    return JSON.stringify(await (context as BrowserContext).storageState());
  }
}
