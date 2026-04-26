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
export declare class GitAdapter {
    private readonly git;
    constructor(repoRoot: string);
    /** Create or switch to a session branch — idempotent */
    createSessionBranch(sessionId: string): Promise<string>;
    /** Stage all changes and commit — returns commit hash */
    commit(repoRoot: string, message: string): Promise<string>;
    /** git stash — returns true if a stash was created */
    stash(repoRoot: string, message: string): Promise<boolean>;
    stashPop(repoRoot: string): Promise<void>;
    stashDrop(repoRoot: string): Promise<void>;
    /** git checkout -- . to discard all uncommitted changes */
    checkoutAll(repoRoot: string): Promise<void>;
    /** git rm a file */
    rm(repoRoot: string, filePath: string): Promise<void>;
    /** Unified diff between session branch and its base */
    diffFromBase(baseBranch?: string): Promise<string>;
    /** git blame for a specific file */
    blame(filePath: string): Promise<string>;
    /** Recent commit log for a file */
    logForFile(filePath: string, maxCount?: number): Promise<string>;
    /** Resolve a merge conflict by accepting the agent's version */
    resolveConflictOurs(filePath: string): Promise<void>;
    /** Create PR — delegated to MCPClientRegistry (stub) */
    createPR(_title: string, _body: string, _baseBranch?: string): Promise<string | null>;
    /** Configure git sparse-checkout for specific subdirectories */
    sparseCheckout(repoRoot: string, paths: string[]): Promise<void>;
    /** Restore full working tree after a sparse-checkout session */
    disableSparseCheckout(repoRoot: string): Promise<void>;
    /** Shallow clone for read-only context injection (depth=1) */
    cloneShallow(remoteUrl: string, targetPath: string, depth?: number): Promise<void>;
}
//# sourceMappingURL=GitAdapter.d.ts.map