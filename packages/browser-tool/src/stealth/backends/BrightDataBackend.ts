// packages/browser-tool/src/stealth/backends/BrightDataBackend.ts
// BrightData residential proxy backend (§5.3). Wraps LocalPlaywrightBackend with proxy.
import { LocalPlaywrightBackend } from './LocalPlaywrightBackend.js';
import type { BrowserSessionConfig } from '@oweibo/core-contracts';
import type { IBrowserBackend, BrowserBackendType } from '../../contracts/IBrowserBackend.js';

export class BrightDataBackend implements IBrowserBackend {
  readonly type: BrowserBackendType = 'brightdata';
  private readonly inner = new LocalPlaywrightBackend();

  constructor(
    private readonly proxyHost: string,
    private readonly proxyUser: string,
    private readonly proxyPass: string,
  ) {}

  async launchContext(config: BrowserSessionConfig, profileDir?: string): Promise<unknown> {
    const zone = config.brightDataZone ?? 'datacenter';
    const augmented: BrowserSessionConfig = {
      ...config,
      egressProxy: {
        server:   `http://${this.proxyHost}`,
        username: `${this.proxyUser}-zone-${zone}`,
        password: this.proxyPass,
      },
    };
    return this.inner.launchContext(augmented, profileDir);
  }

  closeContext(context: unknown): Promise<void> {
    return this.inner.closeContext(context);
  }

  captureStorageState(context: unknown): Promise<string | null> {
    return this.inner.captureStorageState(context);
  }
}
