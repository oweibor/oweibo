/**
 * K.2 — DirectoryClient: the narrow seam between the PrincipalsPort
 * adapter and Google's Admin SDK Directory API.
 *
 * The port adapter is written against this interface; production binds
 * GoogleDirectoryClient (HTTP), tests and certification bind
 * InMemoryDirectoryClient. This composition is private authored code
 * (ADR-012 §3.2 — "composition behind a port is private"); the platform
 * only ever sees the PrincipalsPort.
 */

export interface DirectoryUser {
  readonly id: string;
  readonly primaryEmail: string;
  readonly name?: string;
  readonly suspended?: boolean;
  readonly deleted?: boolean;
}

export interface DirectoryGroup {
  readonly id: string;
  readonly name?: string;
}

export interface DirectoryMember {
  readonly id: string;
  readonly type: 'USER' | 'GROUP' | 'CUSTOMER';
}

export interface DirectoryPage<T> {
  readonly items: readonly T[];
  readonly nextPageToken: string | null;
}

export interface DirectoryClient {
  listUsers(pageToken: string | null): Promise<DirectoryPage<DirectoryUser>>;
  listGroups(pageToken: string | null): Promise<DirectoryPage<DirectoryGroup>>;
  listGroupMembers(groupId: string, pageToken: string | null): Promise<DirectoryPage<DirectoryMember>>;
}

/**
 * In-memory directory with mutation methods, so tests can drive the K.2
 * exit gate ("a group change in Workspace produces MembershipChanged and
 * a version bump") without Google.
 */
export class InMemoryDirectoryClient implements DirectoryClient {
  private readonly users: DirectoryUser[] = [];
  private readonly groups: DirectoryGroup[] = [];
  private readonly members = new Map<string, DirectoryMember[]>();
  private readonly pageSize: number;

  constructor(opts: { pageSize?: number } = {}) {
    this.pageSize = opts.pageSize ?? 2;
  }

  addUser(user: DirectoryUser): void {
    this.users.push(user);
  }
  addGroup(group: DirectoryGroup, members: DirectoryMember[] = []): void {
    this.groups.push(group);
    this.members.set(group.id, members);
  }
  setGroupMembers(groupId: string, members: DirectoryMember[]): void {
    this.members.set(groupId, members);
  }

  async listUsers(pageToken: string | null): Promise<DirectoryPage<DirectoryUser>> {
    return this.page(this.users, pageToken);
  }
  async listGroups(pageToken: string | null): Promise<DirectoryPage<DirectoryGroup>> {
    return this.page(this.groups, pageToken);
  }
  async listGroupMembers(groupId: string, pageToken: string | null): Promise<DirectoryPage<DirectoryMember>> {
    return this.page(this.members.get(groupId) ?? [], pageToken);
  }

  private page<T>(items: readonly T[], pageToken: string | null): DirectoryPage<T> {
    const offset = pageToken === null ? 0 : Number(pageToken);
    const slice = items.slice(offset, offset + this.pageSize);
    const next = offset + slice.length;
    return { items: slice, nextPageToken: next < items.length ? String(next) : null };
  }
}
