// packages/channel-gateway/src/index.ts
// startGateway() bootstrap (§21.11)
import { TelegramAdapter }   from './adapters/TelegramAdapter.js';
import { DiscordAdapter }    from './adapters/DiscordAdapter.js';
import { SlackAdapter }      from './adapters/SlackAdapter.js';
import { WhatsAppAdapter }   from './adapters/WhatsAppAdapter.js';
import { SignalAdapter }     from './adapters/SignalAdapter.js';
import { iMessageAdapter }   from './adapters/iMessageAdapter.js';
import { GoogleChatAdapter } from './adapters/GoogleChatAdapter.js';
import { IRCAdapter }        from './adapters/IRCAdapter.js';
import { WebChatAdapter }    from './adapters/WebChatAdapter.js';
import { ChannelCredentialVault }  from './ChannelCredentialVault.js';
import { BotInstanceManager }      from './BotInstanceManager.js';
import { IdentityResolver }        from './IdentityResolver.js';
import { ChannelRouter }           from './ChannelRouter.js';
import { ChannelEventBridge }      from './ChannelEventBridge.js';
import { ChannelCommandParser }    from './ChannelCommandParser.js';
import type { IChannelAdapter }    from './adapters/IChannelAdapter.js';
import type { Platform }           from '@oweibo/channel-contracts';
import type { ISecretsManager }    from '@oweibo/core-contracts';
import type { Redis }              from 'ioredis';
import type {
  IIntentPipelineGateway,
} from './ChannelRouter.js';
import type {
  ITaskEventBusGateway,
  IDistributedContextStoreGateway,
} from './ChannelEventBridge.js';
import type {
  ITaskInterventionGatewayGateway,
} from './ChannelCommandParser.js';

export interface GatewayDeps {
  secrets:        ISecretsManager;
  redis:          Redis;
  intentPipeline: IIntentPipelineGateway;
  eventBus:       ITaskEventBusGateway;
  interventionGw: ITaskInterventionGatewayGateway;
  contextStore:   IDistributedContextStoreGateway;
  initialRegistrations: Array<{ tenantId: string; platform: Platform }>;
}

export async function startGateway(deps: GatewayDeps): Promise<BotInstanceManager> {
  const jwtSecret = await (deps.secrets as any).getSecret('oweibo/gateway/webchat-jwt-secret') ?? 'change-me';

  const adapters = new Map<Platform, IChannelAdapter>([
    ['telegram',   new TelegramAdapter()],
    ['discord',    new DiscordAdapter()],
    ['slack',      new SlackAdapter()],
    ['whatsapp',   new WhatsAppAdapter()],
    ['signal',     new SignalAdapter()],
    ['imessage',   new iMessageAdapter()],
    ['googlechat', new GoogleChatAdapter()],
    ['irc',        new IRCAdapter()],
    ['webchat',    new WebChatAdapter()],
  ]);

  // Inject jwt secret into WebChatAdapter after construction
  const webchat = adapters.get('webchat') as WebChatAdapter;
  (webchat as unknown as { jwtSecret: string }).jwtSecret = jwtSecret;

  const credVault     = new ChannelCredentialVault(deps.secrets, deps.redis);
  const identity      = new IdentityResolver(deps.redis);
  const commandParser = new ChannelCommandParser(deps.interventionGw, adapters, deps.redis);
  const router        = new ChannelRouter(identity, commandParser, deps.intentPipeline);
  const manager       = new BotInstanceManager(adapters, credVault, router);

  const bridge = new ChannelEventBridge(deps.eventBus, adapters, deps.contextStore);
  bridge.subscribe();

  // Register all (tenantId, platform) pairs declared at startup.
  // Failures are logged but do not abort startup — remaining bots continue.
  const results = await Promise.allSettled(
    deps.initialRegistrations.map(r => manager.register(r)),
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(
        `[channel-gateway] Failed to register bot for`,
        deps.initialRegistrations[i],
        '—', r.reason,
      );
    }
  });

  return manager;
}

export { BotInstanceManager } from './BotInstanceManager.js';
export { ChannelCredentialVault, DuplicateBotTokenError } from './ChannelCredentialVault.js';
export { IdentityResolver } from './IdentityResolver.js';
export { ChannelRouter } from './ChannelRouter.js';
export { ChannelEventBridge } from './ChannelEventBridge.js';
export { ChannelCommandParser } from './ChannelCommandParser.js';
export type { IChannelAdapter, InboundChannelMessage } from './adapters/IChannelAdapter.js';
