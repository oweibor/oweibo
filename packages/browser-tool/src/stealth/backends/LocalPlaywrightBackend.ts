// packages/browser-tool/src/stealth/backends/LocalPlaywrightBackend.ts
// Headless local Chromium via playwright-extra + stealth plugin (§5.1).
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { BrowserContext } from 'playwright';
import type { BrowserSessionConfig } from '@oweibo/core-contracts';
import type { IBrowserBackend, BrowserBackendType } from '../../contracts/IBrowserBackend.js';

chromium.use(StealthPlugin());

export class LocalPlaywrightBackend implements IBrowserBackend {
  readonly type: BrowserBackendType = 'local';

  async launchContext(config: BrowserSessionConfig, profileDir?: string): Promise<unknown> {
    const launchOpts: Record<string, unknown> = {
      headless: true,
      args:     ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    };
    if (config.egressProxy) launchOpts['proxy'] = config.egressProxy;

    const ctxOpts: Record<string, unknown> = {
      locale:     config.locale     ?? 'en-US',
      timezoneId: config.timezoneId ?? 'America/Los_Angeles',
      viewport:   config.viewport   ?? { width: 1280, height: 720 },
    };
    if (config.storageState) ctxOpts['storageState'] = JSON.parse(config.storageState);

    if (profileDir) {
      return await chromium.launchPersistentContext(profileDir, { ...launchOpts, ...ctxOpts });
    }
    const browser = await chromium.launch(launchOpts);
    return await browser.newContext(ctxOpts);
  }

  async closeContext(context: unknown): Promise<void> {
    const ctx = context as BrowserContext;
    const browser = ctx.browser();
    await ctx.close();
    if (browser) await browser.close().catch(() => {});
  }

  async captureStorageState(context: unknown): Promise<string | null> {
    const state = await (context as BrowserContext).storageState();
    return JSON.stringify(state);
  }
}
