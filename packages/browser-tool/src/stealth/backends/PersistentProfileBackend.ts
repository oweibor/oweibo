// packages/browser-tool/src/stealth/backends/PersistentProfileBackend.ts
// Persistent on-disk Chromium profile (§5.20, v9.5.7) — survives restarts, supports
// human-trained sessions and long-running cookie state.
import { chromium } from 'playwright-extra';
import type { BrowserContext } from 'playwright';
import type { BrowserSessionConfig, IProfileStore } from '@oweibo/core-contracts';
import type { IBrowserBackend, BrowserBackendType } from '../../contracts/IBrowserBackend.js';

export class PersistentProfileBackend implements IBrowserBackend {
  readonly type: BrowserBackendType = 'persistent';

  constructor(private readonly profileStore: IProfileStore) {}

  async launchContext(config: BrowserSessionConfig): Promise<unknown> {
    const profileKey = config.persistentProfileId;
    if (!profileKey) throw new Error('[PersistentProfileBackend] persistentProfileId required');

    const profileDir = await (this.profileStore as unknown as { acquireProfileDir(t: string, k: string): Promise<string> })
      .acquireProfileDir(config.tenantId, profileKey);
    return await chromium.launchPersistentContext(profileDir, {
      headless: false,
      viewport: config.viewport ?? { width: 1280, height: 720 },
      locale:   config.locale ?? 'en-US',
      args:     ['--disable-blink-features=AutomationControlled'],
    });
  }

  async closeContext(context: unknown): Promise<void> {
    await (context as BrowserContext).close().catch(() => {});
  }

  async captureStorageState(_context: unknown): Promise<string | null> {
    // Profile is the source of truth — no need for explicit storageState capture.
    return null;
  }
}
