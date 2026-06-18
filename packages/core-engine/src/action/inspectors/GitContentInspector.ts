/**
 * S.5.a: GitContentInspector — guards `write.local.repo_prod` actions
 * against destructive git operations.
 *
 * Refuses outright:
 *   * force-push (`git push --force`, `--force-with-lease`) to a protected
 *     branch (default: main, master, release/*, prod/*)
 *   * commits touching paths under a protected-paths allowlist
 *     (default: .github/, prisma/migrations/, packages/db/migrations/,
 *     packages/core-contracts/, scripts/check-rls.ts)
 *   * direct branch deletion (`git branch -D`, `git push --delete`) on
 *     a protected branch
 *
 * Upgrades to require_approval:
 *   * any rebase/reset --hard against a protected branch
 *   * tag deletion on a release/* tag
 *
 * Payload shape expected:
 *   { command?: string; branch?: string; changedPaths?: string[]; tag?: string }
 */
import type {
  ActionContext,
  ContentInspectionResult,
  IContentInspector,
} from '@oweibo/core-contracts';

interface GitPayload {
  command?: string;
  branch?: string;
  changedPaths?: string[];
  tag?: string;
}

const DEFAULT_PROTECTED_BRANCHES: ReadonlySet<string> = new Set([
  'main', 'master', 'production', 'prod',
]);

const DEFAULT_PROTECTED_BRANCH_PREFIXES: readonly string[] = [
  'release/', 'prod/',
];

const DEFAULT_PROTECTED_PATHS: readonly string[] = [
  '.github/',
  'prisma/migrations/',
  'packages/db/migrations/',
  'packages/core-contracts/',
  'scripts/check-rls.ts',
];

export interface GitInspectorOptions {
  protectedBranches?: ReadonlySet<string>;
  protectedBranchPrefixes?: readonly string[];
  protectedPaths?: readonly string[];
}

export class GitContentInspector implements IContentInspector {
  readonly name = 'git_content';
  private readonly protectedBranches: ReadonlySet<string>;
  private readonly protectedBranchPrefixes: readonly string[];
  private readonly protectedPaths: readonly string[];

  constructor(opts: GitInspectorOptions = {}) {
    this.protectedBranches = opts.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES;
    this.protectedBranchPrefixes = opts.protectedBranchPrefixes ?? DEFAULT_PROTECTED_BRANCH_PREFIXES;
    this.protectedPaths = opts.protectedPaths ?? DEFAULT_PROTECTED_PATHS;
  }

  appliesTo(actionClass: string): boolean {
    return actionClass === 'write.local.repo_prod';
  }

  async inspect(ctx: ActionContext): Promise<ContentInspectionResult> {
    const p = (ctx.payload ?? {}) as GitPayload;
    const cmd = (p.command ?? '').toLowerCase();
    const branch = p.branch ?? '';
    const isProtectedBranch = this.isProtectedBranch(branch);

    // Force-push to protected branch.
    if (isProtectedBranch && /\bpush\b/.test(cmd) && /--force(?:-with-lease)?/.test(cmd)) {
      return {
        verdict: 'forbid',
        reason: `force-push to protected branch '${branch}' is never allowed`,
        details: { matched: 'FORCE_PUSH_PROTECTED', branch },
      };
    }

    // Branch deletion of a protected branch.
    if (isProtectedBranch && (/\bbranch\b.*-D\b/.test(cmd) || /\bpush\b.*--delete\b/.test(cmd))) {
      return {
        verdict: 'forbid',
        reason: `branch deletion of protected branch '${branch}' is never allowed`,
        details: { matched: 'BRANCH_DELETE_PROTECTED', branch },
      };
    }

    // Touching protected paths.
    const changed = p.changedPaths ?? [];
    const touched = changed.filter((path) =>
      this.protectedPaths.some((prefix) => path === prefix || path.startsWith(prefix)),
    );
    if (touched.length > 0) {
      return {
        verdict: 'forbid',
        reason: `commit touches protected path(s): ${touched.slice(0, 3).join(', ')}${touched.length > 3 ? '…' : ''}`,
        details: { matched: 'PROTECTED_PATH', paths: touched },
      };
    }

    // Rebase / reset --hard on protected branch.
    if (isProtectedBranch && (/\brebase\b/.test(cmd) || /\breset\b.*--hard\b/.test(cmd))) {
      return {
        verdict: 'upgrade_to_approval',
        reason: `rebase/reset --hard on protected branch '${branch}' requires approval`,
        details: { matched: 'REBASE_OR_RESET_PROTECTED', branch },
      };
    }

    // Tag deletion on release/*.
    if (p.tag && p.tag.startsWith('release/') && /\btag\b.*-d\b/.test(cmd)) {
      return {
        verdict: 'upgrade_to_approval',
        reason: `release tag deletion '${p.tag}' requires approval`,
        details: { matched: 'RELEASE_TAG_DELETE', tag: p.tag },
      };
    }

    return { verdict: 'allow' };
  }

  private isProtectedBranch(branch: string): boolean {
    if (this.protectedBranches.has(branch)) return true;
    return this.protectedBranchPrefixes.some((prefix) => branch.startsWith(prefix));
  }
}
