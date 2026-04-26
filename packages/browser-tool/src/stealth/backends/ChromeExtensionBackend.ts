// packages/browser-tool/src/stealth/backends/ChromeExtensionBackend.ts
// ChromeExtensionBackend (§5.21, v9.5.8) — relays actions to the Oweibo Chrome
// Extension via ExtensionBridgeServer (WebSocket). Returns an opaque proxy
// "context" object that BrowserTool actions resolve via the bridge.
import type { BrowserSessionConfig } from '@oweibo/core-contracts';
import type { IBrowserBackend, BrowserBackendType } from '../../contracts/IBrowserBackend.js';
import type { ExtensionBridgeServer } from '../../session/ExtensionBridgeServer.js';

export interface ExtensionContextProxy {
  readonly _kind: 'extension';
  readonly tenantId: string;
  readonly sessionId: string;
}

export class ChromeExtensionBackend implements IBrowserBackend {
  readonly type: BrowserBackendType = 'extension';

  constructor(private readonly bridge: ExtensionBridgeServer) {}

  async launchContext(config: BrowserSessionConfig): Promise<unknown> {
    // Bridge must already have a paired extension client for this tenant.
    const ok = await (this.bridge as unknown as { hasClient(t: string): Promise<boolean> }).hasClient(config.tenantId);
    if (!ok) throw new Error('[ChromeExtensionBackend] no paired extension client for tenant');

    const proxy: ExtensionContextProxy = {
      _kind:     'extension',
      tenantId:  config.tenantId,
      sessionId: config.sessionId,
    };
    return proxy;
  }

  async closeContext(_context: unknown): Promise<void> { /* extension owns lifecycle */ }
  async captureStorageState(_context: unknown): Promise<string | null> { return null; }
}
