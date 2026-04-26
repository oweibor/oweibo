// packages/core-engine/src/general-coding/editing/EditApplicator.ts
// Atomic multi-file apply via git (§16f.10)
import { writeFile, mkdir, readFile } from 'fs/promises';
import { dirname, join, resolve, normalize } from 'path';
import type { EditProposal } from '../GeneralCodingAgent.js';
import type { GitAdapter } from '../git/GitAdapter.js';
import type { WarmPoolManager } from '../../sandbox/WarmPoolManager.js';
import type { ISecurityContext } from '@oweibo/core-contracts';
import type { VirtualFileSystemValidator, VfsDiagnostic } from './VirtualFileSystemValidator.js';

export class VfsValidationError extends Error {
  constructor(public readonly diagnostics: VfsDiagnostic[]) {
    const summary = diagnostics.slice(0, 3).map(d => `${d.filePath}:${d.line}:${d.column} ${d.message}`).join('; ');
    super(`[EditApplicator] VFS pre-flight compile failed (${diagnostics.length} diag): ${summary}`);
    this.name = 'VfsValidationError';
  }
}

export interface ApplyResult {
  commitHash:  string;
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
export class EditApplicator {
  constructor(
    private readonly git:       GitAdapter,
    private readonly warmPool:  WarmPoolManager,
    private readonly vfsValidator: VirtualFileSystemValidator,
  ) {}

  async apply(
    repoRoot:  string,
    proposal:  EditProposal,
    taskId:    string,
    sessionId: string,
    secCtx:    ISecurityContext = { permissions: ['workspace:write'] } as ISecurityContext,
  ): Promise<ApplyResult> {
    const editedFiles:   string[] = [];
    const normalizedRoot = normalize(resolve(repoRoot));

    // Path traversal guard
    for (const { filePath } of [...proposal.proposal, ...proposal.newFiles]) {
      const resolved = resolve(join(normalizedRoot, filePath));
      if (!resolved.startsWith(normalizedRoot + '/') && resolved !== normalizedRoot) {
        throw new Error(`[EditApplicator] Path traversal blocked: ${filePath}`);
      }
    }

    // Dry-run in sandbox
    const sandbox = await this.warmPool.acquire(secCtx, { timeoutMs: 30_000 });
    try {
      for (const { filePath, diff } of proposal.proposal) {
        const hostPath    = join(normalizedRoot, filePath);
        const fileContent = await readFile(hostPath, 'utf8').catch(() => '');
        await sandbox.execute(`mkdir -p /tmp/dryrun && printf '%s' ${JSON.stringify(fileContent)} > /tmp/dryrun/target`, 'bash');
        const result = await sandbox.execute(
          `cd /tmp/dryrun && patch --dry-run -p0 target <<'PATCH'\n${diff}\nPATCH`,
          'bash',
        );
        if (result.exitCode !== 0) {
          throw new Error(`[EditApplicator] Dry-run failed for ${filePath}: ${result.stderr}`);
        }
      }
    } finally {
      await this.warmPool.release(sandbox);
    }

    // G16: Pre-flight VFS compilation gate.
    // Builds the post-patch state in memory and runs ts-morph diagnostics.
    // Blocks disk writes when the proposal would produce code that does not compile.
    const proposedContents = new Map<string, string>();
    for (const { filePath, diff } of proposal.proposal) {
      const hostPath = join(normalizedRoot, filePath);
      const original = await readFile(hostPath, 'utf8').catch(() => '');
      proposedContents.set(filePath, this.applyUnifiedDiff(original, diff));
    }
    for (const { filePath, content } of proposal.newFiles) {
      proposedContents.set(filePath, content);
    }
    const filesToValidate = [
      ...proposal.proposal.map(p => p.filePath),
      ...proposal.newFiles.map(f => f.filePath),
    ];
    const vfsResult = await this.vfsValidator.validate(filesToValidate, proposedContents);
    if (!vfsResult.passed) {
      throw new VfsValidationError(vfsResult.diagnostics);
    }

    // git stash for rollback
    const stashCreated = await this.git.stash(normalizedRoot, `oweibo-backup-${taskId}`);

    try {
      // Apply patches on host
      for (const { filePath, diff } of proposal.proposal) {
        const hostPath = join(normalizedRoot, filePath);
        const original = await readFile(hostPath, 'utf8');
        const patched  = this.applyUnifiedDiff(original, diff);
        await writeFile(hostPath, patched, 'utf8');
        editedFiles.push(filePath);
      }

      // Write new files
      for (const { filePath, content } of proposal.newFiles) {
        const hostPath = join(normalizedRoot, filePath);
        await mkdir(dirname(hostPath), { recursive: true });
        await writeFile(hostPath, content, 'utf8');
        editedFiles.push(filePath);
      }

      // Remove deleted files
      for (const filePath of proposal.deletedFiles) {
        await this.git.rm(normalizedRoot, filePath);
      }

      const commitHash = await this.git.commit(
        normalizedRoot,
        `oweibo[${taskId.slice(0, 8)}]: ${proposal.explanation.slice(0, 72)}`,
      );

      if (stashCreated) await this.git.stashDrop(normalizedRoot).catch(() => null);

      return { commitHash, editedFiles };

    } catch (err) {
      await this.git.checkoutAll(normalizedRoot).catch(() => null);
      if (stashCreated) await this.git.stashPop(normalizedRoot).catch(() => null);
      throw err;
    }
  }

  /**
   * Pure-JS unified diff applier — handles standard unified diff format (---/+++ headers, @@ hunks).
   */
  private applyUnifiedDiff(original: string, diff: string): string {
    const lines     = original.split('\n');
    const diffLines = diff.split('\n');
    const result    = [...lines];
    let offset      = 0;

    for (let i = 0; i < diffLines.length; i++) {
      const line = diffLines[i]!;
      if (line.startsWith('@@')) {
        const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
        if (!match) continue;
        const oldStart  = parseInt(match[1]!, 10) - 1;
        const removals: number[] = [];
        const additions: string[] = [];
        let j = i + 1;
        while (j < diffLines.length && !diffLines[j]!.startsWith('@@') && !diffLines[j]!.startsWith('diff ')) {
          const hunkLine = diffLines[j]!;
          if (hunkLine.startsWith('-') && !hunkLine.startsWith('---')) {
            removals.push(oldStart + removals.length + offset);
          } else if (hunkLine.startsWith('+') && !hunkLine.startsWith('+++')) {
            additions.push(hunkLine.slice(1));
          }
          j++;
        }
        for (const idx of removals.reverse()) result.splice(idx, 1);
        result.splice(oldStart + offset, 0, ...additions);
        offset += additions.length - removals.length;
        i = j - 1;
      }
    }
    return result.join('\n');
  }
}
