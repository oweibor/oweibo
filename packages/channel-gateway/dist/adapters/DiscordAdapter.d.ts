import type { IChannelAdapter, InboundChannelMessage } from './IChannelAdapter.js';
export declare class DiscordAdapter implements IChannelAdapter {
    readonly platform: "discord";
    private readonly clients;
    start(token: string, onMessage: (msg: InboundChannelMessage) => Promise<void>): Promise<void>;
    stop(token: string): Promise<void>;
    sendMessage(token: string, chatId: string, text: string): Promise<void>;
    sendTypingIndicator(token: string, chatId: string): Promise<void>;
}
//# sourceMappingURL=DiscordAdapter.d.ts.map