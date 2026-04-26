// packages/channel-gateway/src/adapters/WhatsAppAdapter.ts
// Meta Cloud API — webhook-push model via Webhook Edge Forwarder (§21.14)
// token is JSON: { accessToken, phoneNumberId } — stored in Vault extras
import type { IChannelAdapter, InboundChannelMessage } from './IChannelAdapter.js';

export class WhatsAppAdapter implements IChannelAdapter {
  readonly platform = 'whatsapp' as const;
  private readonly handlers = new Map<string, (msg: InboundChannelMessage) => Promise<void>>();

  async start(token: string, onMessage: (msg: InboundChannelMessage) => Promise<void>): Promise<void> {
    const { phoneNumberId } = JSON.parse(token) as { phoneNumberId: string };
    this.handlers.set(phoneNumberId, onMessage);
    // Inbound via webhook edge forwarder → handleWebhook()
  }

  async stop(token: string): Promise<void> {
    const { phoneNumberId } = JSON.parse(token) as { phoneNumberId: string };
    this.handlers.delete(phoneNumberId);
  }

  /** Called by the webhook router — X-Hub-Signature-256 already verified at edge */
  async handleWebhook(token: string, payload: Record<string, unknown>): Promise<void> {
    const { phoneNumberId } = JSON.parse(token) as { phoneNumberId: string };
    const handler = this.handlers.get(phoneNumberId);
    if (!handler) return;

    const entries = payload['entry'] as Array<Record<string, unknown>> | undefined;
    const message = (entries?.[0]?.['changes'] as Array<Record<string, unknown>>)?.[0]
      ?.['value'] as Record<string, unknown> | undefined;
    const msg = (message?.['messages'] as Array<Record<string, unknown>>)?.[0];
    if (!msg || msg['type'] !== 'text') return;

    await handler({
      platform: 'whatsapp',
      botToken: token,
      platformUserId: msg['from'] as string,
      platformChatId: msg['from'] as string,
      text: (msg['text'] as Record<string, string>)['body'] ?? '',
      messageId: msg['id'] as string,
      timestamp: Number(msg['timestamp']) * 1000,
    });
  }

  async sendMessage(token: string, chatId: string, text: string): Promise<void> {
    const { accessToken, phoneNumberId } = JSON.parse(token) as {
      accessToken: string; phoneNumberId: string;
    };
    await fetch(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: chatId,
        type: 'text',
        text: { body: text },
      }),
    });
  }
}
