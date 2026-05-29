/**
 * Unit tests for GitRollbackAdapter.
 *
 * Stubs SimpleGit + fs.access; no live repo touched. Covers preflight
 * refusals, missing commit, happy revert path, no-op-already-reverted,
 * and conflict failure.
 */
import type { SimpleGit } from 'simple-git';
import type { RollbackContext, RollbackEnvelope } from '@oweibo/core-contracts';
import { GitRollbackAdapter } from '../GitRollbackAdapter.js';

const ctx: RollbackContext = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  originalActionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  originalPlanId: null,
  invokedBy: { type: 'human', id: 'operator' },
  correlationId: 'corr-1',
};

interface FakeGitState {
  isRepo: boolean;
  reachableShas: Set<string>;
  head: string;
  revertOutput?: string;
  revertError?: Error;
  /** When true, head doesn't move on revert (simulates already-reverted). */
  noopOnRevert?: boolean;
}

function makeGit(state: FakeGitState): SimpleGit {
  const stub: Partial<SimpleGit> = {
    checkIsRepo: jest.fn(async () => state.isRepo) as unknown as SimpleGit['checkIsRepo'],
    raw: jest.fn(async (args: unknown) => {
      const a = args as string[];
      if (a[0] === 'cat-file') {
        const sha = (a[2] ?? '').replace('^{commit}', '');
        if (!state.reachableShas.has(sha)) throw new Error('not found');
        return '';
      }
      if (a[0] === 'revert') {
        if (state.revertError) throw state.revertError;
        if (state.noopOnRevert !== true) state.head = `new-${state.head}`;
        return state.revertOutput ?? `Reverted ${a.at(-1)}`;
      }
      return '';
    }) as unknown as SimpleGit['raw'],
    revparse: jest.fn(async () => state.head) as unknown as SimpleGit['revparse'],
  };
  return stub as SimpleGit;
}

const SHA = 'a1b2c3d4e5f6789012345678901234567890abcd';
const goodPlan = { workingClonePath: '/tmp/repo', commitSha: SHA };

describe('GitRollbackAdapter.preflight', () => {
  it('refuses envelope.kind=irreversible', async () => {
    const adapter = new GitRollbackAdapter({
      gitFactory: () => makeGit({ isRepo: true, reachableShas: new Set([SHA]), head: 'H0' }),
      accessFs: async () => undefined,
    });
    const env: RollbackEnvelope = { kind: 'irreversible', details: '', rollbackPlan: goodPlan };
    await expect(adapter.preflight(env, ctx)).rejects.toThrow(/irreversible/);
  });

  it('refuses missing rollbackPlan', async () => {
    const adapter = new GitRollbackAdapter({ accessFs: async () => undefined });
    await expect(adapter.preflight({ kind: 'trivial', details: '' }, ctx)).rejects.toThrow(/missing rollbackPlan/);
  });

  it('refuses malformed commitSha', async () => {
    const adapter = new GitRollbackAdapter({ accessFs: async () => undefined });
    const env: RollbackEnvelope = {
      kind: 'trivial', details: '',
      rollbackPlan: { workingClonePath: '/tmp/repo', commitSha: 'not-a-sha' },
    };
    await expect(adapter.preflight(env, ctx)).rejects.toThrow(/commitSha/);
  });

  it('refuses when workingClonePath does not exist', async () => {
    const adapter = new GitRollbackAdapter({
      accessFs: async () => { throw new Error('ENOENT'); },
    });
    const env: RollbackEnvelope = { kind: 'trivial', details: '', rollbackPlan: goodPlan };
    await expect(adapter.preflight(env, ctx)).rejects.toThrow(/does not exist/);
  });

  it('refuses when path is not a git repo', async () => {
    const adapter = new GitRollbackAdapter({
      gitFactory: () => makeGit({ isRepo: false, reachableShas: new Set(), head: 'H0' }),
      accessFs: async () => undefined,
    });
    const env: RollbackEnvelope = { kind: 'trivial', details: '', rollbackPlan: goodPlan };
    await expect(adapter.preflight(env, ctx)).rejects.toThrow(/not a git repository/);
  });

  it('refuses when commit is unreachable', async () => {
    const adapter = new GitRollbackAdapter({
      gitFactory: () => makeGit({ isRepo: true, reachableShas: new Set(), head: 'H0' }),
      accessFs: async () => undefined,
    });
    const env: RollbackEnvelope = { kind: 'trivial', details: '', rollbackPlan: goodPlan };
    await expect(adapter.preflight(env, ctx)).rejects.toThrow(/not reachable/);
  });

  it('passes preflight for a well-formed plan + reachable commit', async () => {
    const adapter = new GitRollbackAdapter({
      gitFactory: () => makeGit({ isRepo: true, reachableShas: new Set([SHA]), head: 'H0' }),
      accessFs: async () => undefined,
    });
    const env: RollbackEnvelope = { kind: 'trivial', details: '', rollbackPlan: goodPlan };
    await expect(adapter.preflight(env, ctx)).resolves.toBeUndefined();
  });
});

describe('GitRollbackAdapter.execute', () => {
  it('runs git revert --no-edit <sha> and surfaces new HEAD as side effect', async () => {
    const state: FakeGitState = { isRepo: true, reachableShas: new Set([SHA]), head: 'H0' };
    const adapter = new GitRollbackAdapter({
      gitFactory: () => makeGit(state),
      accessFs: async () => undefined,
    });
    const r = await adapter.execute({ kind: 'trivial', details: '', rollbackPlan: goodPlan }, ctx);
    expect(r.state).toBe('fully_reverted');
    expect(r.sideEffects.some(s => s.startsWith('git.revert_sha='))).toBe(true);
  });

  it('returns no_op_already_reverted when revert produces no change', async () => {
    const state: FakeGitState = { isRepo: true, reachableShas: new Set([SHA]), head: 'H0', noopOnRevert: true };
    const adapter = new GitRollbackAdapter({
      gitFactory: () => makeGit(state),
      accessFs: async () => undefined,
    });
    const r = await adapter.execute({ kind: 'trivial', details: '', rollbackPlan: goodPlan }, ctx);
    expect(r.state).toBe('no_op_already_reverted');
  });

  it('returns no_op_already_reverted on "nothing to commit" git output', async () => {
    const state: FakeGitState = {
      isRepo: true, reachableShas: new Set([SHA]), head: 'H0',
      revertError: new Error('On branch main\nnothing to commit, working tree clean'),
    };
    const adapter = new GitRollbackAdapter({
      gitFactory: () => makeGit(state),
      accessFs: async () => undefined,
    });
    const r = await adapter.execute({ kind: 'trivial', details: '', rollbackPlan: goodPlan }, ctx);
    expect(r.state).toBe('no_op_already_reverted');
  });

  it('returns failed on revert conflict', async () => {
    const state: FakeGitState = {
      isRepo: true, reachableShas: new Set([SHA]), head: 'H0',
      revertError: new Error('CONFLICT: merge conflict in foo.txt'),
    };
    const adapter = new GitRollbackAdapter({
      gitFactory: () => makeGit(state),
      accessFs: async () => undefined,
    });
    const r = await adapter.execute({ kind: 'trivial', details: '', rollbackPlan: goodPlan }, ctx);
    expect(r.success).toBe(false);
    expect(r.state).toBe('failed');
    expect(r.details).toMatch(/CONFLICT/);
  });
});
