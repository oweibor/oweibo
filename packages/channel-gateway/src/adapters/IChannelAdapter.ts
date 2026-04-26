/**
 * IChannelAdapter — platform-agnostic contract (§21.3).
 * All nine platform adapters implement this interface.
 * Adapters do not manage their own lifecycle — BotInstanceManager calls start/stop.
 * Each adapter instance is owned by exactly one (tenantId, platform) registration.
 */
import type { Platform } from '@oweibo/channel-contracts';

/**
 * Normalised inbound message. Every platform adapter maps its native format to this
 * before passing to ChannelRouter. No platform-specific types escape this boundary.
 */
export interface InboundChannelMessage {
  platform: Platform;
  /** Identifies which (tenantId, platform) binding this belongs to */
  botToken: string;
  platformUserId: string;
  platformChatId: string;
  text: string;
  attachments?: Buffer[];
  messageId: string;
  timestamp: number;
}

export interface IChannelAdapter {
  readonly platform: Platform;

  /**
   * Initialise with a tenant-specific bot token.
   * MUST NOT store token in any shared or static state.
   * The token reference lives only in the adapter's instance scope.
   */
  start(token: string, onMessage: (msg: InboundChannelMessage) => Promise<void>): Promise<void>;

  /** Graceful shutdown — called by BotInstanceManager on deregistration or SIGTERM. */
  stop(token: string): Promise<void>;

  /** Send a text reply to a specific platform chat. Called by ChannelEventBridge. */
  sendMessage(token: string, chatId: string, text: string): Promise<void>;

  /**
   * Optional: show "typing…" indicator while agent processes.
   * Telegram, Discord, Slack implement this. Others may no-op.
   */
  sendTypingIndicator?(token: string, chatId: string): Promise<void>;
}
