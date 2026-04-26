// packages/channel-gateway/src/adapters/SlackAdapter.ts
// @slack/bolt — Socket Mode
// token is JSON: { botToken, signingSecret, appToken } — stored in Vault extras
import { App } from '@slack/bolt';
import type { IChannelAdapter, InboundChannelMessage } from './IChannelAdapter.js';

export class SlackAdapter implements IChannelAdapter {
  readonly platform = 'slack' as const;
  private readonly apps = new Map<string, App>();

  async start(token: string, onMessage: (msg: InboundChannelMessage) => Promise<void>): Promise<void> {
    const { botToken, signingSecret, appToken } = JSON.parse(token) as {
      botToken: string; signingSecret: string; appToken: string;
    };
    const app = new App({ token: botToken, signingSecret, socketMode: true, appToken });

    app.message(async ({ message }) => {
      if (message.subtype || !('user' in message) || !('text' in message)) return;
      await onMessage({
        platform: 'slack',
        botToken,
        platformUserId: (message as { user: string }).user,
        platformChatId: (message as { channel: string }).channel,
        text: (message as { text?: string }).text ?? '',
        messageId: (message as { ts: string }).ts,
        timestamp: Number((message as { ts: string }).ts) * 1000,
      });
    });

    await app.start();
    this.apps.set(botToken, app);
  }

  async stop(token: string): Promise<void> {
    const { botToken } = JSON.parse(token) as { botToken: string };
    await this.apps.get(botToken)?.stop();
    this.apps.delete(botToken);
  }

  async sendMessage(token: string, chatId: string, text: string): Promise<void> {
    const { botToken } = JSON.parse(token) as { botToken: string };
    await this.apps.get(botToken)?.client.chat.postMessage({ channel: chatId, text });
  }
  // Slack has no typing indicator API for bots — sendTypingIndicator intentionally absent
}
