// packages/channel-gateway/src/adapters/GoogleChatAdapter.ts
// @googleapis/chat — service account; webhook-push via Webhook Edge Forwarder (§21.14)
// token is JSON: { serviceAccountJson, spaceId }
import type { IChannelAdapter, InboundChannelMessage } from './IChannelAdapter.js';

export class GoogleChatAdapter implements IChannelAdapter {
  readonly platform = 'googlechat' as const;
  private readonly handlers = new Map<string, (msg: InboundChannelMessage) => Promise<void>>();

  async start(token: string, onMessage: (msg: InboundChannelMessage) => Promise<void>): Promise<void> {
    const { spaceId } = JSON.parse(token) as { serviceAccountJson: string; spaceId: string };
    this.handlers.set(spaceId, onMessage);
    // Inbound via webhook edge forwarder → handleWebhook()
  }

  async stop(token: string): Promise<void> {
    const { spaceId } = JSON.parse(token) as { spaceId: string };
    this.handlers.delete(spaceId);
  }

  /** Called by the webhook router for /webhooks/googlechat/{tenantId} */
  async handleWebhook(token: string, payload: Record<string, unknown>): Promise<void> {
    const { spaceId } = JSON.parse(token) as { spaceId: string };
    const handler = this.handlers.get(spaceId);
    if (!handler) return;

    if (payload['type'] !== 'MESSAGE') return;
    const msg = payload['message'] as Record<string, unknown> | undefined;
    const sender = msg?.['sender'] as Record<string, unknown> | undefined;
    if (!msg || !sender) return;

    await handler({
      platform: 'googlechat',
      botToken: token,
      platformUserId: sender['name'] as string,
      platformChatId: (payload['space'] as Record<string, unknown>)?.['name'] as string ?? spaceId,
      text: (msg['argumentText'] as string | undefined ?? msg['text'] as string | undefined ?? '').trim(),
      messageId: msg['name'] as string,
      timestamp: Date.now(),
    });
  }

  async sendMessage(token: string, chatId: string, text: string): Promise<void> {
    const { serviceAccountJson } = JSON.parse(token) as { serviceAccountJson: string };
    // In production: use @googleapis/chat with service account credentials to post to the space
    // Stub — real implementation authenticates via google-auth-library
    console.info('[GoogleChatAdapter] sendMessage', { chatId, serviceAccount: !!serviceAccountJson });
    void text;
  }
}
