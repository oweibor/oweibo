// packages/channel-gateway/src/adapters/iMessageAdapter.ts
// Apple Business Chat REST API — webhook-push via Webhook Edge Forwarder (§21.14)
// Requires Apple Business Chat account per tenant (enterprise verification required).
// token is JSON: { businessId, privateKeyPem } — stored in Vault extras
import type { IChannelAdapter, InboundChannelMessage } from './IChannelAdapter.js';

export class iMessageAdapter implements IChannelAdapter {
  readonly platform = 'imessage' as const;
  private readonly handlers = new Map<string, (msg: InboundChannelMessage) => Promise<void>>();

  async start(token: string, onMessage: (msg: InboundChannelMessage) => Promise<void>): Promise<void> {
    const { businessId } = JSON.parse(token) as { businessId: string };
    this.handlers.set(businessId, onMessage);
    // Inbound messages arrive via Apple webhook — handled by WebhookRouter calling handleWebhook()
  }

  async stop(token: string): Promise<void> {
    const { businessId } = JSON.parse(token) as { businessId: string };
    this.handlers.delete(businessId);
  }

  /** Called by the webhook router. Edge forwarder strips external headers before forwarding. */
  async handleWebhook(token: string, payload: Record<string, unknown>): Promise<void> {
    const { businessId } = JSON.parse(token) as { businessId: string };
    const handler = this.handlers.get(businessId);
    if (!handler) return;

    // Apple Business Messages text message envelope
    const msg = payload as {
      id?: string;
      body?: string;
      sourceId?: string;
      conversationId?: string;
      sentDate?: string;
    };
    if (!msg.body || !msg.sourceId) return;

    await handler({
      platform: 'imessage',
      botToken: token,
      platformUserId: msg.sourceId,
      platformChatId: msg.conversationId ?? msg.sourceId,
      text: msg.body,
      messageId: msg.id ?? String(Date.now()),
      timestamp: msg.sentDate ? new Date(msg.sentDate).getTime() : Date.now(),
    });
  }

  async sendMessage(token: string, chatId: string, text: string): Promise<void> {
    // Apple Business Messages REST API send endpoint
    const { businessId, privateKeyPem } = JSON.parse(token) as {
      businessId: string; privateKeyPem: string;
    };
    // Auth: JWT signed with privateKeyPem — implementation requires apple-messages-for-business SDK
    // Stubbed: real implementation uses @apple/messages-for-business or direct REST calls
    console.info('[iMessageAdapter] sendMessage', { businessId, chatId, text: text.slice(0, 50) });
    void privateKeyPem; // used for JWT signing in production
  }
}
