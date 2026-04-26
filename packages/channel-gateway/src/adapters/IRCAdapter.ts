// packages/channel-gateway/src/adapters/IRCAdapter.ts
// node-irc — NickServ-aware. Falls back to ephemeral UUID nick for unidentified users.
// token is JSON: { server, port, nick, nickServPassword?, channels }
const irc: any = {};
import { randomUUID } from 'crypto';
import type { IChannelAdapter, InboundChannelMessage } from './IChannelAdapter.js';

export class IRCAdapter implements IChannelAdapter {
  readonly platform = 'irc' as const;
  private readonly clients = new Map<string, any>();

  async start(token: string, onMessage: (msg: InboundChannelMessage) => Promise<void>): Promise<void> {
    const { server, port = 6667, nick, nickServPassword, channels = [] } = JSON.parse(token) as {
      server: string;
      port?: number;
      nick: string;
      nickServPassword?: string;
      channels: string[];
    };

    // Use NickServ-identified nick when available; fall back to UUID-suffixed ephemeral nick
    const effectiveNick = nickServPassword ? nick : `${nick}-${randomUUID().slice(0, 8)}`;

    const client = new irc.Client(server, effectiveNick, {
      port,
      autoConnect: true,
      channels,
      secure: port === 6697,
    });

    if (nickServPassword) {
      client.addListener('registered', () => {
        client.say('NickServ', `IDENTIFY ${nickServPassword}`);
      });
    }

    client.addListener('message', async (from: string, to: string, text: string) => {
      // Only process private messages (DMs) to the bot
      if (to !== effectiveNick) return;
      await onMessage({
        platform: 'irc',
        botToken: token,
        platformUserId: from,
        platformChatId: from,
        text,
        messageId: `${Date.now()}:${from}`,
        timestamp: Date.now(),
      });
    });

    this.clients.set(token, client);
  }

  async stop(token: string): Promise<void> {
    this.clients.get(token)?.disconnect('Shutting down', () => undefined);
    this.clients.delete(token);
  }

  async sendMessage(token: string, chatId: string, text: string): Promise<void> {
    this.clients.get(token)?.say(chatId, text);
  }
}
