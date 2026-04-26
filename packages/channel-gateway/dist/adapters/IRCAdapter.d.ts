import type { IChannelAdapter, InboundChannelMessage } from './IChannelAdapter.js';
export declare class IRCAdapter implements IChannelAdapter {
    readonly platform: "irc";
    private readonly clients;
    start(token: string, onMessage: (msg: InboundChannelMessage) => Promise<void>): Promise<void>;
    stop(token: string): Promise<void>;
    sendMessage(token: string, chatId: string, text: string): Promise<void>;
}
//# sourceMappingURL=IRCAdapter.d.ts.map