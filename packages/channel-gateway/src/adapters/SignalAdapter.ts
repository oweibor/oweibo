// packages/channel-gateway/src/adapters/SignalAdapter.ts
// bbernhard/signal-cli-rest-api sidecar — polling model
// token is JSON: { apiUrl, number, receiveIntervalMs? }
// Gate behind Vault flag: oweibo/gateway/signal-enabled (default: false)
import type { IChannelAdapter, InboundChannelMessage } from './IChannelAdapter.js';

export class SignalAdapter implements IChannelAdapter {
  readonly platform = 'signal' as const;
  private readonly pollers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly handlers = new Map<string, (msg: InboundChannelMessage) => Promise<void>>();

  async start(token: string, onMessage: (msg: InboundChannelMessage) => Promise<void>): Promise<void> {
    const { apiUrl, number, receiveIntervalMs = 3000 } = JSON.parse(token) as {
      apiUrl: string; number: string; receiveIntervalMs?: number;
    };
    this.handlers.set(number, onMessage);

    const poller = setInterval(async () => {
      try {
        const res = await fetch(`${apiUrl}/v1/receive/${encodeURIComponent(number)}`);
        if (!res.ok) return;
        for (const msg of (await res.json()) as Array<Record<string, unknown>>) {
          const env = msg['envelope'] as Record<string, unknown> | undefined;
          const data = env?.['dataMessage'] as Record<string, unknown> | undefined;
          if (!data?.['message']) continue;
          await onMessage({
            platform: 'signal',
            botToken: token,
            platformUserId: env?.['source'] as string,
            platformChatId: env?.['source'] as string,
            text: data['message'] as string,
            messageId: String(env?.['timestamp']),
            timestamp: env?.['timestamp'] as number,
          });
        }
      } catch (e) {
        console.error('[SignalAdapter] poll error:', e);
      }
    }, receiveIntervalMs);

    this.pollers.set(number, poller);
  }

  async stop(token: string): Promise<void> {
    const { number } = JSON.parse(token) as { number: string };
    clearInterval(this.pollers.get(number));
    this.pollers.delete(number);
    this.handlers.delete(number);
  }

  async sendMessage(token: string, chatId: string, text: string): Promise<void> {
    const { apiUrl, number } = JSON.parse(token) as { apiUrl: string; number: string };
    await fetch(`${apiUrl}/v2/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, number, recipients: [chatId] }),
    });
  }
}
