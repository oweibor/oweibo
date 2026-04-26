// packages/channel-gateway/src/BotInstanceManager.ts
// Per-tenant bot lifecycle manager (§21.5)
import type { IChannelAdapter, InboundChannelMessage } from './adapters/IChannelAdapter.js';
import type { ChannelCredentialVault } from './ChannelCredentialVault.js';
import type { ChannelRouter } from './ChannelRouter.js';
import type { Platform } from '@oweibo/channel-contracts';

export interface BotRegistration {
  tenantId: string;
  platform: Platform;
}

/**
 * Manages the lifecycle of per-tenant bot instances.
 *
 * ISOLATION GUARANTEE: the `onMessage` handler passed to adapter.start() is a closure
 * that captures `tenantId` at registration time. The adapter never sees `tenantId`
 * explicitly — it cannot be overridden by message content. ChannelRouter receives it
 * as a parameter from this closure, making cross-tenant routing structurally impossible
 * regardless of what any user sends.
 */
export class BotInstanceManager {
  // key: `${tenantId}:${platform}`
  private readonly instances = new Map<string, { token: string; adapter: IChannelAdapter }>();

  constructor(
    private readonly adapters: Map<Platform, IChannelAdapter>,
    private readonly credVault: ChannelCredentialVault,
    private readonly router: ChannelRouter,
  ) {}

  async register(reg: BotRegistration): Promise<void> {
    const key = `${reg.tenantId}:${reg.platform}`;
    if (this.instances.has(key)) {
      throw new Error(`Bot already registered for ${key}. Call deregister() first.`);
    }

    const adapter = this.adapters.get(reg.platform);
    if (!adapter) throw new Error(`No adapter registered for platform: ${reg.platform}`);

    const cred = await this.credVault.load(reg.tenantId, reg.platform);

    // Duplicate-token check — throws DuplicateBotTokenError on conflict
    await this.credVault.registerCredential(cred);

    // ISOLATION: tenantId is closed over here. The adapter receives only the token.
    const { tenantId } = reg;
    const onMessage = async (msg: InboundChannelMessage): Promise<void> => {
      await this.router.handle(msg, tenantId);
    };

    await adapter.start(cred.botToken, onMessage);
    this.instances.set(key, { token: cred.botToken, adapter });
  }

  async deregister(reg: BotRegistration): Promise<void> {
    const key = `${reg.tenantId}:${reg.platform}`;
    const instance = this.instances.get(key);
    if (!instance) return;

    await instance.adapter.stop(instance.token);
    await this.credVault.evict(reg.tenantId, reg.platform);
    this.instances.delete(key);
  }

  async shutdown(): Promise<void> {
    const entries = [...this.instances.entries()];
    await Promise.allSettled(
      entries.map(async ([key, { token, adapter }]) => {
        const colonIdx = key.indexOf(':');
        const tenantId = key.slice(0, colonIdx);
        const platform = key.slice(colonIdx + 1) as Platform;
        await adapter.stop(token).catch(e =>
          console.error(`[BotInstanceManager] shutdown error for ${key}:`, e),
        );
        await this.credVault.evict(tenantId, platform);
      }),
    );
    this.instances.clear();
  }
}
