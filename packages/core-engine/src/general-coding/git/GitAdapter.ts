// packages/core-engine/src/general-coding/git/GitAdapter.ts
// Git as a first-class operational primitive (§16f.12, §16f.12b, G5, G20)
import simpleGit, { type SimpleGit } from 'simple-git';

/**
 * GitAdapter — wraps simple-git for the general coding path.
 *
 * Session lifecycle:
 *   - createSessionBranch() called once per session
 *   - All edits committed on the session branch
 *   - createPR() optionally opens a PR at session end (via GitHub MCP)
 *
 * All methods are idempotent where possible — safe to call on worker restarts.
 * G20: Adds sparseCheckout(), disableSparseCheckout(), cloneShallow() for monorepo efficiency.
 */
export class GitAdapter {
  private readonly git: SimpleGit;

  constructor(repoRoot: string) {
    this.git = simpleGit(repoRoot);
  }

  /** Create or switch to a session branch — idempotent */
  async createSessionBranch(sessionId: string): Promise<string> {
    const branchName = `oweibo/session-${sessionId.slice(0, 8)}`;
    const branches   = await this.git.branchLocal();
    if (!branches.all.includes(branchName)) {
      await this.git.checkoutLocalBranch(branchName);
    } else {
      await this.git.checkout(branchName);
    }
    return branchName;
  }

  /** Stage all changes and commit — returns commit hash */
  async commit(repoRoot: string, message: string): Promise<string> {
    await this.git.add('-A');
    const result = await this.git.commit(message);
    return result.commit;
  }

  /** git stash — returns true if a stash was created */
  async stash(repoRoot: string, message: string): Promise<boolean> {
    const result = await this.git.stash(['push', '-m', message]);
    return !result.includes('No local changes');
  }

  async stashPop(repoRoot: string): Promise<void> {
    await this.git.stash(['pop']);
  }

  async stashDrop(repoRoot: string): Promise<void> {
    await this.git.stash(['drop']);
  }

  /** git checkout -- . to discard all uncommitted changes */
  async checkoutAll(repoRoot: string): Promise<void> {
    await this.git.checkout(['--', '.']);
  }

  /** git rm a file */
  async rm(repoRoot: string, filePath: string): Promise<void> {
    await this.git.rm(filePath);
  }

  /** Unified diff between session branch and its base */
  async diffFromBase(baseBranch: string = 'main'): Promise<string> {
    return await this.git.diff([`${baseBranch}...HEAD`]);
  }

  /** git blame for a specific file */
  async blame(filePath: string): Promise<string> {
    return await this.git.raw(['blame', '--line-porcelain', filePath]);
  }

  /** Recent commit log for a file */
  async logForFile(filePath: string, maxCount: number = 5): Promise<string> {
    const log = await this.git.log({
      file:     filePath,
      maxCount,
      format:   { hash: '%h', date: '%ar', message: '%s', author_name: '%an' },
    });
    return log.all.map(e => `${e.hash} (${e.date}) ${e.author_name}: ${e.message}`).join('\n');
  }

  /** Resolve a merge conflict by accepting the agent's version */
  async resolveConflictOurs(filePath: string): Promise<void> {
    await this.git.checkout(['--ours', filePath]);
    await this.git.add(filePath);
  }

  /** Create PR — delegated to MCPClientRegistry (stub) */
  async createPR(_title: string, _body: string, _baseBranch: string = 'main'): Promise<string | null> {
    return null; // Full implementation in §16h MCPClientRegistry wire-up
  }

  // ── G20: Sparse checkout + shallow clone ────────────────────────────────

  /** Configure git sparse-checkout for specific subdirectories */
  async sparseCheckout(repoRoot: string, paths: string[]): Promise<void> {
    const git = simpleGit(repoRoot);
    await git.raw(['sparse-checkout', 'init', '--cone']);
    await git.raw(['sparse-checkout', 'set', ...paths]);
  }

  /** Restore full working tree after a sparse-checkout session */
  async disableSparseCheckout(repoRoot: string): Promise<void> {
    const git = simpleGit(repoRoot);
    await git.raw(['sparse-checkout', 'disable']);
  }

  /** Shallow clone for read-only context injection (depth=1) */
  async cloneShallow(remoteUrl: string, targetPath: string, depth = 1): Promise<void> {
    const git = simpleGit();
    await git.clone(remoteUrl, targetPath, ['--depth', String(depth), '--single-branch']);
  }
}
