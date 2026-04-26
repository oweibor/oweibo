"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.iMessageAdapter = void 0;
class iMessageAdapter {
    platform = 'imessage';
    handlers = new Map();
    async start(token, onMessage) {
        const { businessId } = JSON.parse(token);
        this.handlers.set(businessId, onMessage);
        // Inbound messages arrive via Apple webhook — handled by WebhookRouter calling handleWebhook()
    }
    async stop(token) {
        const { businessId } = JSON.parse(token);
        this.handlers.delete(businessId);
    }
    /** Called by the webhook router. Edge forwarder strips external headers before forwarding. */
    async handleWebhook(token, payload) {
        const { businessId } = JSON.parse(token);
        const handler = this.handlers.get(businessId);
        if (!handler)
            return;
        // Apple Business Messages text message envelope
        const msg = payload;
        if (!msg.body || !msg.sourceId)
            return;
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
    async sendMessage(token, chatId, text) {
        // Apple Business Messages REST API send endpoint
        const { businessId, privateKeyPem } = JSON.parse(token);
        // Auth: JWT signed with privateKeyPem — implementation requires apple-messages-for-business SDK
        // Stubbed: real implementation uses @apple/messages-for-business or direct REST calls
        console.info('[iMessageAdapter] sendMessage', { businessId, chatId, text: text.slice(0, 50) });
        void privateKeyPem; // used for JWT signing in production
    }
}
exports.iMessageAdapter = iMessageAdapter;
//# sourceMappingURL=iMessageAdapter.js.map