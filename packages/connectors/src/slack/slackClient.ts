/**
 * K.9 — SlackClient: the seam between the slack ports and the Slack Web API.
 * Production binds a real WebClient; tests and the certification battery bind
 * InMemorySlackClient, whose mutation methods drive the K.9 walkthroughs
 * (post → discovery → index; channel membership change → ACL bump).
 *
 * The Slack model, mapped onto the SDK's object/ACL contract:
 *   - the indexed OBJECT is a message, ref = `${channelId}:${ts}` (Slack's ts
 *     is the stable per-message id AND its revision — an edit bumps it);
 *   - a message's AUDIENCE is its channel's membership: everyone in the channel
 *     may read it, nobody has write (Slack messages are immutable to readers).
 *   That collapses Slack's sharing model onto the same AclSnapshot shape Drive
 *   uses, so the platform's §6 visibility logic is source-agnostic.
 */

export interface SlackMessage {
  readonly channelId: string;
  /** Slack ts — stable id and revision in one. An edit produces a new ts pointer via editedTs. */
  readonly ts: string;
  readonly text: string;
  readonly userId: string;
  /** Set when the message was edited; the revision the platform indexes. */
  readonly editedTs?: string;
  readonly deleted?: boolean;
}

export interface SlackChange {
  readonly channelId: string;
  readonly ts: string;
  readonly removed: boolean;
  readonly message?: SlackMessage;
}

export interface SlackChangePage {
  readonly changes: readonly SlackChange[];
  readonly nextCursor: string | null;
  /** Present on the final page: the standing resume point (delta sync). */
  readonly newStartCursor?: string;
}

export interface SlackClient {
  getStartCursor(): Promise<string>;
  listChanges(cursor: string): Promise<SlackChangePage>;
  /** Snapshot surface for the initial crawl (history cannot replay arbitrarily far). */
  listMessages(cursor: string | null): Promise<{ messages: readonly SlackMessage[]; nextCursor: string | null }>;
  getMessage(ref: string): Promise<SlackMessage>;
  /** conversations.members — the channel membership that IS the message audience. */
  channelMembers(channelId: string): Promise<readonly string[]>;
}

/** Split a message ref into channel + ts. */
export function parseMessageRef(ref: string): { channelId: string; ts: string } {
  const idx = ref.indexOf(':');
  if (idx < 0) throw new Error(`slack: malformed message ref ${ref}`);
  return { channelId: ref.slice(0, idx), ts: ref.slice(idx + 1) };
}

export function messageRef(channelId: string, ts: string): string {
  return `${channelId}:${ts}`;
}

/**
 * In-memory Slack with a change log. Every mutation appends a change entry;
 * cursors are log offsets, and draining past the tail yields a fresh start
 * cursor exactly like a real resumable history feed.
 */
export class InMemorySlackClient implements SlackClient {
  private readonly messages = new Map<string, SlackMessage>();       // ref → message
  private readonly members = new Map<string, string[]>();            // channelId → user ids
  private readonly log: SlackChange[] = [];
  private readonly pageSize: number;

  constructor(opts: { pageSize?: number } = {}) {
    this.pageSize = opts.pageSize ?? 2;
  }

  // ── Mutations (the "something happened in Slack" surface) ────────────────

  setMembers(channelId: string, userIds: string[]): void {
    this.members.set(channelId, [...userIds]);
  }

  postMessage(m: Omit<SlackMessage, 'editedTs' | 'deleted'>): void {
    const msg: SlackMessage = { ...m };
    const ref = messageRef(m.channelId, m.ts);
    this.messages.set(ref, msg);
    this.log.push({ channelId: m.channelId, ts: m.ts, removed: false, message: msg });
  }

  editMessage(channelId: string, ts: string, text: string, editedTs: string): void {
    const ref = messageRef(channelId, ts);
    const cur = this.messages.get(ref);
    if (!cur) throw new Error(`InMemorySlackClient: no message ${ref}`);
    const next: SlackMessage = { ...cur, text, editedTs };
    this.messages.set(ref, next);
    this.log.push({ channelId, ts, removed: false, message: next });
  }

  deleteMessage(channelId: string, ts: string): void {
    const ref = messageRef(channelId, ts);
    this.messages.delete(ref);
    this.log.push({ channelId, ts, removed: true });
  }

  // ── SlackClient ──────────────────────────────────────────────────────────

  async getStartCursor(): Promise<string> {
    return `c:${this.log.length}`;
  }

  async listChanges(cursor: string): Promise<SlackChangePage> {
    const offset = this.decode(cursor);
    const slice = this.log.slice(offset, offset + this.pageSize);
    const next = offset + slice.length;
    if (next < this.log.length) {
      return { changes: slice, nextCursor: `c:${next}` };
    }
    return { changes: slice, nextCursor: null, newStartCursor: `c:${next}` };
  }

  async listMessages(cursor: string | null): Promise<{ messages: readonly SlackMessage[]; nextCursor: string | null }> {
    const all = [...this.messages.values()];
    const offset = cursor === null ? 0 : Number(cursor.replace(/^m:/, ''));
    const slice = all.slice(offset, offset + this.pageSize);
    const next = offset + slice.length;
    return { messages: slice, nextCursor: next < all.length ? `m:${next}` : null };
  }

  async getMessage(ref: string): Promise<SlackMessage> {
    const m = this.messages.get(ref);
    if (!m) throw new Error(`message not found: ${ref}`);
    return m;
  }

  async channelMembers(channelId: string): Promise<readonly string[]> {
    return this.members.get(channelId) ?? [];
  }

  private decode(token: string): number {
    const m = /^c:(\d+)$/.exec(token);
    if (!m) throw new Error(`InMemorySlackClient: unknown cursor ${token}`);
    return Number(m[1]);
  }
}
