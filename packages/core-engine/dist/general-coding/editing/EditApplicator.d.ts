import type { EditProposal } from '../GeneralCodingAgent.js';
import type { GitAdapter } from '../git/GitAdapter.js';
import type { WarmPoolManager } from '../../sandbox/WarmPoolManager.js';
import type { ISecurityContext } from '@oweibo/core-contracts';
import type { VirtualFileSystemValidator, VfsDiagnostic } from './VirtualFileSystemValidator.js';
export declare class VfsValidationError extends Error {
    readonly diagnostics: VfsDiagnostic[];
    constructor(diagnostics: VfsDiagnostic[]);
}
export interface ApplyResult {
    commitHash: string;
    editedFiles: string[];
}
/**
 * EditApplicator — applies an EditProposal atomically using git.
 *
 * v9.1 critical fix: Patches applied directly on host filesystem (not sandbox),
 * since git commit operates on the host. Sandbox used ONLY for dry-run validation.
 *
 * Sequence:
 *   1. Path traversal guard for all files in the proposal
 *   2. Dry-run patches in sandbox (fail-fast without touching host)
 *   3. git stash (capture rollback point)
 *   4. Apply patches on host
 *   5. Write new files on host
 *   6. git rm deleted files
 *   7. git commit
 *   8. On any error: git checkout -- . && git stash pop
 */
export declare class EditApplicator {
    private readonly git;
    private readonly warmPool;
    private readonly vfsValidator;
    constructor(git: GitAdapter, warmPool: WarmPoolManager, vfsValidator: VirtualFileSystemValidator);
    apply(repoRoot: string, proposal: EditProposal, taskId: string, sessionId: string, secCtx?: ISecurityContext): Promise<ApplyResult>;
    /**
     * Pure-JS unified diff applier — handles standard unified diff format (---/+++ headers, @@ hunks).
     */
    private applyUnifiedDiff;
}
//# sourceMappingURL=EditApplicator.d.ts.map