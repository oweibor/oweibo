/**
 * K.3 — DriveClient: the seam between the google-drive ports and the
 * Drive API v3. Production binds GoogleDriveClient; tests and the
 * certification battery bind InMemoryDriveClient, whose mutation methods
 * drive the K.3 walkthroughs (change → discovery → index; revocation).
 */

export interface DriveFileMeta {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly modifiedTime: string;
  /** Drive's monotonically increasing per-file version. */
  readonly version: number;
  readonly trashed?: boolean;
}

export interface DriveChange {
  readonly fileId: string;
  readonly removed: boolean;
  readonly file?: DriveFileMeta;
}

export interface DriveChangePage {
  readonly changes: readonly DriveChange[];
  readonly nextPageToken: string | null;
  /** Present on the final page: the standing resume point (delta sync). */
  readonly newStartPageToken?: string;
}

export interface DrivePermission {
  readonly id: string;
  readonly type: 'user' | 'group' | 'domain' | 'anyone';
  readonly emailAddress?: string;
  readonly domain?: string;
  readonly role: 'owner' | 'organizer' | 'fileOrganizer' | 'writer' | 'commenter' | 'reader';
}

export interface DriveFilePage {
  readonly files: readonly DriveFileMeta[];
  readonly nextPageToken: string | null;
}

export interface DriveClient {
  getStartPageToken(): Promise<string>;
  listChanges(pageToken: string): Promise<DriveChangePage>;
  /** files.list — the initial-crawl surface (the changes API cannot
   *  replay history; a ChangeFeedPort composes both, ADR-012 §3.2). */
  listFiles(pageToken: string | null): Promise<DriveFilePage>;
  getFile(fileId: string): Promise<DriveFileMeta>;
  listPermissions(fileId: string): Promise<readonly DrivePermission[]>;
  /** Push-notification channel management (webhook lifecycle hooks). */
  watchChanges(channelId: string): Promise<void>;
  stopChannel(channelId: string): Promise<void>;
}

/**
 * In-memory Drive with a change log. Every mutation appends a change
 * entry; page tokens are log offsets, and draining past the tail yields
 * a fresh start token exactly like the real changes API.
 */
export class InMemoryDriveClient implements DriveClient {
  private readonly files = new Map<string, DriveFileMeta>();
  private readonly permissions = new Map<string, DrivePermission[]>();
  private readonly log: DriveChange[] = [];
  readonly channels = new Set<string>();
  private readonly pageSize: number;

  constructor(opts: { pageSize?: number } = {}) {
    this.pageSize = opts.pageSize ?? 2;
  }

  // ── Mutations (the "something happened in Drive" surface) ─────────────

  putFile(meta: Omit<DriveFileMeta, 'version'>, permissions: DrivePermission[]): void {
    const existing = this.files.get(meta.id);
    const next: DriveFileMeta = { ...meta, version: (existing?.version ?? 0) + 1 };
    this.files.set(meta.id, next);
    this.permissions.set(meta.id, permissions);
    this.log.push({ fileId: meta.id, removed: false, file: next });
  }

  touchFile(fileId: string): void {
    const f = this.files.get(fileId);
    if (!f) throw new Error(`InMemoryDriveClient: no file ${fileId}`);
    const next = { ...f, version: f.version + 1 };
    this.files.set(fileId, next);
    this.log.push({ fileId, removed: false, file: next });
  }

  setPermissions(fileId: string, permissions: DrivePermission[]): void {
    const f = this.files.get(fileId);
    if (!f) throw new Error(`InMemoryDriveClient: no file ${fileId}`);
    this.permissions.set(fileId, permissions);
    const next = { ...f, version: f.version + 1 };
    this.files.set(fileId, next);
    this.log.push({ fileId, removed: false, file: next });
  }

  deleteFile(fileId: string): void {
    this.files.delete(fileId);
    this.permissions.delete(fileId);
    this.log.push({ fileId, removed: true });
  }

  /** Bump a file's version WITHOUT a change-log entry — simulates the
   *  index falling behind the source (the §16.2 conflict case). */
  silentBump(fileId: string): void {
    const f = this.files.get(fileId);
    if (!f) throw new Error(`InMemoryDriveClient: no file ${fileId}`);
    this.files.set(fileId, { ...f, version: f.version + 1 });
  }

  // ── DriveClient ────────────────────────────────────────────────────────

  async getStartPageToken(): Promise<string> {
    return `t:${this.log.length}`;
  }

  async listChanges(pageToken: string): Promise<DriveChangePage> {
    const offset = this.decode(pageToken);
    const slice = this.log.slice(offset, offset + this.pageSize);
    const next = offset + slice.length;
    if (next < this.log.length) {
      return { changes: slice, nextPageToken: `t:${next}` };
    }
    return { changes: slice, nextPageToken: null, newStartPageToken: `t:${next}` };
  }

  async listFiles(pageToken: string | null): Promise<DriveFilePage> {
    const all = [...this.files.values()];
    const offset = pageToken === null ? 0 : Number(pageToken.replace(/^f:/, ''));
    const slice = all.slice(offset, offset + this.pageSize);
    const next = offset + slice.length;
    return { files: slice, nextPageToken: next < all.length ? `f:${next}` : null };
  }

  async getFile(fileId: string): Promise<DriveFileMeta> {
    const f = this.files.get(fileId);
    if (!f) throw new Error(`file not found: ${fileId}`);
    return f;
  }

  async listPermissions(fileId: string): Promise<readonly DrivePermission[]> {
    return this.permissions.get(fileId) ?? [];
  }

  async watchChanges(channelId: string): Promise<void> {
    this.channels.add(channelId);
  }

  async stopChannel(channelId: string): Promise<void> {
    this.channels.delete(channelId);
  }

  private decode(token: string): number {
    const m = /^t:(\d+)$/.exec(token);
    if (!m) throw new Error(`InMemoryDriveClient: unknown page token ${token}`);
    return Number(m[1]);
  }
}
