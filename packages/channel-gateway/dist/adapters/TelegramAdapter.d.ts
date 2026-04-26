import type { IChannelAdapter, InboundChannelMessage } from './IChannelAdapter.js';
export declare class TelegramAdapter implements IChannelAdapter {
    readonly platform: "telegram";
    private readonly bots;
    start(token: string, onMessage: (msg: InboundChannelMessage) => Promise<void>): Promise<void>;
    stop(token: string): Promise<void>;
    sendMessage(token: string, chatId: string, text: string): Promise<void>;
    sendTypingIndicator(token: string, chatId: string): Promise<void>;
}
//# sourceMappingURL=TelegramAdapter.d.ts.map