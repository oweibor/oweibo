/**
 * @oweibo/channel-contracts
 *
 * Zero-dependency shared channel types (NEW v9.3 §21.2).
 * Imported by both core-contracts and channel-gateway to avoid circular dependencies.
 * Do NOT add any runtime dependencies to this package.
 */

/**
 * All supported social channel platforms and first-party ingestion channels.
 * Nine social platforms added in v9.3 alongside existing 'api' and 'cli'.
 */
export type Platform =
  | 'telegram'
  | 'discord'
  | 'slack'
  | 'whatsapp'
  | 'signal'
  | 'imessage'
  | 'googlechat'
  | 'irc'
  | 'webchat'
  | 'api'
  | 'cli';

/**
 * Where to send an outbound reply for a channel-originated task.
 * Populated by ChannelRouter at RawIntent submission time.
 * Stored in DistributedContextStore keyed on task:{taskId}:channelReplyTarget
 * so ChannelEventBridge can retrieve it per TaskEventBus event.
 */
export interface ChannelReplyTarget {
  /** The platform this reply targets. */
  readonly platform: Platform;
  /** Platform-specific chat / channel / room identifier. */
  readonly chatId: string;
  /** Optional thread or message ID for threaded replies (Discord threads, Slack threads, etc.). */
  readonly threadId?: string;
  /**
   * SHA-256 hash of the bot token that received the original message.
   * BotInstanceManager uses this to select the correct adapter instance for the reply.
   * The raw token is never stored here — only the hash.
   */
  readonly botTokenHash: string;
}
