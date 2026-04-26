// packages/browser-tool/src/stealth/backends/UserChromeBackend.ts
// Attaches to a user's Chrome started with --remote-debugging-port (§5.19, v9.5.6).
import { chromium } from 'playwright-extra';
import type { BrowserContext } from 'playwright';
import type { BrowserSessionConfig } from '@oweibo/core-contracts';
import type { IBrowserBackend, BrowserBackendType } from '../../contracts/IBrowserBackend.js';

export class UserChromeBackend implements IBrowserBackend {
  readonly type: BrowserBackendType = 'userchrome';

  async launchContext(config: BrowserSessionConfig): Promise<unknown> {
    const cdp = config.cdpEndpoint ?? 'http://localhost:9222';
    const browser = await chromium.connectOverCDP(cdp);
    const ctxs = browser.contexts();
    if (ctxs.length === 0) throw new Error('[UserChromeBackend] no existing contexts to attach to');
    return ctxs[0];
  }

  /** Never close the user's browser. */
  async closeContext(_context: unknown): Promise<void> { /* no-op */ }

  async captureStorageState(_context: unknown): Promise<string | null> { return null; }
}
