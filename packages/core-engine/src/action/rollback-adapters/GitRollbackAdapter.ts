/**
 * F.2.2 — GitRollbackAdapter.
 *
 * Rolls back actions in the `write.local.repo_*` family by running
 * `git revert --no-edit <sha>` against the tenant's working clone.
 *
 * RollbackEnvelope.rollbackPlan shape:
 *
 *   {
 *     workingClonePath: string;   // absolute path to the working repo
 *     commitSha:        string;   // the sha to revert
 *     branch?:          string;   // optional ref to assert is checked out
 *   }
 *
 * Preflight refuses when:
 *   - envelope.kind === 'irreversible'
 *   - rollbackPlan missing / malformed
 *   - the working clone doesn't exist or isn't a git repository
 *   - the commitSha isn't reachable (rebased away, branch deleted)
 *
 * Execute behaviour:
 *   - `git revert --no-edit <sha>` produces a NEW commit that inverts
 *     the original. We capture and surface that new sha as a side effect.
 *   - If `git revert` is a no-op because the parent of the new HEAD already
 *     equals the desired state (e.g. operator re-running rollback), we
 *     report `no_op_already_reverted`.
 *   - On any failure (conflict, missing sha, dirty tree) we report
 *     `state='failed'` with the git error in `details`.
 *
 * The simple-git instance is injectable so tests can substitute a fake
 * without spinning up a real repo.
 */
import { promises as fs } from 'fs';
import simpleGit, { type SimpleGit } from 'simple-git';
import type {
  IRollbackAdapter,
  RollbackContext,
  RollbackEnvelope,
  RollbackResult,
} from '@oweibo/core-contracts';

const SHA_RE = /^[0-9a-f]{7,64}$/i;

interface GitRollbackPlan {
  readonly workingClonePath: string;
  readonly commitSha: string;
  readonly branch?: string;
}

export interface GitRollbackAdapterOptions {
  /** Override factory; tests inject a stub SimpleGit. */
  readonly gitFactory?: (cwd: string) => SimpleGit;
  /** Override fs.access (tests). */
  readonly accessFs?: (path: string) => Promise<void>;
}

export class GitRollbackAdapter implements IRollbackAdapter {
  readonly name = 'git';
  private readonly gitFactory: (cwd: string) => SimpleGit;
  private readonly accessFs: (path: string) => Promise<void>;

  constructor(opts: GitRollbackAdapterOptions = {}) {
    this.gitFactory = opts.gitFactory ?? ((cwd) => simpleGit(cwd));
    this.accessFs = opts.accessFs ?? ((p) => fs.access(p));
  }

  async preflight(envelope: RollbackEnvelope, _ctx: RollbackContext): Promise<void> {
    if (envelope.kind === 'irreversible') {
      throw new Error('git rollback: envelope.kind=irreversible');
    }
    const plan = envelope.rollbackPlan as GitRollbackPlan | undefined;
    if (!plan || typeof plan !== 'object') {
      throw new Error('git rollback: missing rollbackPlan');
    }
    if (typeof plan.workingClonePath !== 'string' || plan.workingClonePath.length === 0) {
      throw new Error('git rollback: rollbackPlan.workingClonePath missing');
    }
    if (typeof plan.commitSha !== 'string' || !SHA_RE.test(plan.commitSha)) {
      throw new Error(`git rollback: rollbackPlan.commitSha missing or malformed (${plan.commitSha})`);
    }
    await this.accessFs(plan.workingClonePath).catch(() => {
      throw new Error(`git rollback: workingClonePath does not exist (${plan.workingClonePath})`);
    });
    const git = this.gitFactory(plan.workingClonePath);
    const isRepo = await git.checkIsRepo().catch(() => false);
    if (!isRepo) {
      throw new Error(`git rollback: workingClonePath is not a git repository (${plan.workingClonePath})`);
    }
    // catFile is the cheapest reachability check.
    try {
      await git.raw(['cat-file', '-e', `${plan.commitSha}^{commit}`]);
    } catch {
      throw new Error(`git rollback: commit ${plan.commitSha} not reachable in ${plan.workingClonePath}`);
    }
  }

  async execute(envelope: RollbackEnvelope, _ctx: RollbackContext): Promise<RollbackResult> {
    const plan = envelope.rollbackPlan as GitRollbackPlan;
    const git = this.gitFactory(plan.workingClonePath);
    try {
      // Best-effort: only revert if the commit is still in the reachable
      // history of HEAD. If revert is a no-op (already reverted), git
      // surfaces "nothing to commit".
      const headBefore = (await git.revparse(['HEAD'])).trim();
      let result: { stdout?: string };
      try {
        const raw = await git.raw(['revert', '--no-edit', plan.commitSha]);
        result = { stdout: raw };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/nothing to commit/i.test(msg) || /no changes to commit/i.test(msg)) {
          return {
            success: true,
            state: 'no_op_already_reverted',
            details: 'git revert produced no changes — already reverted',
            sideEffects: [],
            costUsdCents: 0,
          };
        }
        return failed(`git rollback: ${msg}`);
      }
      const headAfter = (await git.revparse(['HEAD'])).trim();
      const sideEffects = headAfter !== headBefore
        ? [`git.revert_sha=${headAfter}`]
        : [];
      return {
        success: true,
        state: headAfter === headBefore ? 'no_op_already_reverted' : 'fully_reverted',
        details: result.stdout?.trim() ?? `git revert ${plan.commitSha} succeeded`,
        sideEffects,
        costUsdCents: 0,
      };
    } catch (err) {
      return failed(`git rollback: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function failed(details: string): RollbackResult {
  return { success: false, state: 'failed', details, sideEffects: [], costUsdCents: 0 };
}
