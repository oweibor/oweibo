/**
 * K.9 — GithubClient: the seam between the github ports and the GitHub REST
 * API. Production binds a real Octokit client; tests and the certification
 * battery bind InMemoryGithubClient.
 *
 * The GitHub model, mapped onto the SDK's object/ACL contract:
 *   - the indexed OBJECT is an issue, ref = `${repo}#${number}` (repo-qualified
 *     issue number is the stable id); its revision is GitHub's updated_at,
 *     which advances on every edit/comment;
 *   - a private repo's AUDIENCE is its collaborators (with GitHub's read/write/
 *     admin permission mapped onto the SDK's read/write/owner);
 *   - the change feed is issues.list ordered by updated_at — a real delta feed,
 *     resumable from the last-seen updated_at watermark (deltaSync).
 */

export type GithubPermission = 'read' | 'triage' | 'write' | 'maintain' | 'admin';

export interface GithubCollaborator {
  readonly login: string;
  readonly permission: GithubPermission;
}

export interface GithubIssue {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly state: 'open' | 'closed';
  /** ISO-8601; advances on any edit/comment — the revision watermark. */
  readonly updatedAt: string;
  readonly deleted?: boolean;
}

export interface GithubChange {
  readonly repo: string;
  readonly number: number;
  readonly removed: boolean;
  readonly issue?: GithubIssue;
}

export interface GithubChangePage {
  readonly changes: readonly GithubChange[];
  readonly nextCursor: string | null;
  /** The updated_at watermark to resume from (delta sync). */
  readonly newStartCursor?: string;
}

export interface GithubClient {
  getStartCursor(): Promise<string>;
  listChanges(cursor: string): Promise<GithubChangePage>;
  listIssues(cursor: string | null): Promise<{ issues: readonly GithubIssue[]; nextCursor: string | null }>;
  getIssue(ref: string): Promise<GithubIssue>;
  repoCollaborators(repo: string): Promise<readonly GithubCollaborator[]>;
}

export function issueRef(repo: string, number: number): string {
  return `${repo}#${number}`;
}

export function parseIssueRef(ref: string): { repo: string; number: number } {
  const idx = ref.lastIndexOf('#');
  if (idx < 0) throw new Error(`github: malformed issue ref ${ref}`);
  return { repo: ref.slice(0, idx), number: Number(ref.slice(idx + 1)) };
}

/**
 * In-memory GitHub with a change log. Cursors are log offsets; draining past
 * the tail yields a fresh start cursor exactly like an updated_at-watermarked
 * issues feed.
 */
export class InMemoryGithubClient implements GithubClient {
  private readonly issues = new Map<string, GithubIssue>();       // ref → issue
  private readonly collaborators = new Map<string, GithubCollaborator[]>();
  private readonly log: GithubChange[] = [];
  private readonly pageSize: number;

  constructor(opts: { pageSize?: number } = {}) {
    this.pageSize = opts.pageSize ?? 2;
  }

  // ── Mutations ────────────────────────────────────────────────────────────

  setCollaborators(repo: string, collaborators: GithubCollaborator[]): void {
    this.collaborators.set(repo, [...collaborators]);
  }

  putIssue(issue: GithubIssue): void {
    const ref = issueRef(issue.repo, issue.number);
    const existed = this.issues.has(ref);
    this.issues.set(ref, issue);
    this.log.push({ repo: issue.repo, number: issue.number, removed: false, issue });
    void existed;
  }

  touchIssue(repo: string, number: number, updatedAt: string): void {
    const ref = issueRef(repo, number);
    const cur = this.issues.get(ref);
    if (!cur) throw new Error(`InMemoryGithubClient: no issue ${ref}`);
    const next: GithubIssue = { ...cur, updatedAt };
    this.issues.set(ref, next);
    this.log.push({ repo, number, removed: false, issue: next });
  }

  deleteIssue(repo: string, number: number): void {
    const ref = issueRef(repo, number);
    this.issues.delete(ref);
    this.log.push({ repo, number, removed: true });
  }

  // ── GithubClient ───────────────────────────────────────────────────────

  async getStartCursor(): Promise<string> {
    return `g:${this.log.length}`;
  }

  async listChanges(cursor: string): Promise<GithubChangePage> {
    const offset = this.decode(cursor);
    const slice = this.log.slice(offset, offset + this.pageSize);
    const next = offset + slice.length;
    if (next < this.log.length) {
      return { changes: slice, nextCursor: `g:${next}` };
    }
    return { changes: slice, nextCursor: null, newStartCursor: `g:${next}` };
  }

  async listIssues(cursor: string | null): Promise<{ issues: readonly GithubIssue[]; nextCursor: string | null }> {
    const all = [...this.issues.values()];
    const offset = cursor === null ? 0 : Number(cursor.replace(/^i:/, ''));
    const slice = all.slice(offset, offset + this.pageSize);
    const next = offset + slice.length;
    return { issues: slice, nextCursor: next < all.length ? `i:${next}` : null };
  }

  async getIssue(ref: string): Promise<GithubIssue> {
    const i = this.issues.get(ref);
    if (!i) throw new Error(`issue not found: ${ref}`);
    return i;
  }

  async repoCollaborators(repo: string): Promise<readonly GithubCollaborator[]> {
    return this.collaborators.get(repo) ?? [];
  }

  private decode(token: string): number {
    const m = /^g:(\d+)$/.exec(token);
    if (!m) throw new Error(`InMemoryGithubClient: unknown cursor ${token}`);
    return Number(m[1]);
  }
}
