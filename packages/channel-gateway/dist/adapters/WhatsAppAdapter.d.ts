import type { IChannelAdapter, InboundChannelMessage } from './IChannelAdapter.js';
export declare class WhatsAppAdapter implements IChannelAdapter {
    readonly platform: "whatsapp";
    private readonly handlers;
    start(token: string, onMessage: (msg: InboundChannelMessage) => Promise<void>): Promise<void>;
    stop(token: string): Promise<void>;
    /** Called by the webhook router — X-Hub-Signature-256 already verified at edge */
    handleWebhook(token: string, payload: Record<string, unknown>): Promise<void>;
    sendMessage(token: string, chatId: string, text: string): Promise<void>;
}
//# sourceMappingURL=WhatsAppAdapter.d.ts.map