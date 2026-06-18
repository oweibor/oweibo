/**
 * F.5.10 — PgDomainIntakeProcessor tests.
 */
import type { Pool, PoolClient, QueryResult } from 'pg';
import type { DomainIntakeService } from '../../DomainIntakeService.js';
import type { IRepoSandbox } from '../RepoScanSandbox.js';
import { RepoScanError } from '../RepoScanSandbox.js';
import { PgDomainIntakeProcessor } from '../PgDomainIntakeProcessor.js';

interface MockState {
  initialState: 'requested' | 'pending' | 'complete' | 'failed' | 'processing' | 'absent';
  interviewAnswers?: Record<string, unknown> | null;
  repoScanSummary?:  Record<string, unknown> | null;
}

function makePool(state: MockState): { pool: Pool; queries: { text: string; values?: unknown[] }[] } {
  const queries: { text: string; values?: unknown[] }[] = [];
  const client: Partial<PoolClient> = {
    query: ((text: string, values?: unknown[]): Promise<QueryResult> => {
      queries.push({ text, values });
      if (text.includes('UPDATE oweibo.tenant_domain_intake') && text.includes("'processing'")) {
        // claimRow: only succeeds when state IS 'requested'.
        const claimed = state.initialState === 'requested';
        return Promise.resolve({
          rows: claimed ? [{
            intake_state: 'processing',
            interview_answers: state.interviewAnswers ?? null,
            repo_scan_summary: state.repoScanSummary ?? null,
            primer_doc_count: 0,
          }] : [],
          rowCount: claimed ? 1 : 0,
          command: 'UPDATE', oid: 0, fields: [],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
    }) as PoolClient['query'],
    release: jest.fn(),
  };
  return {
    pool: {
      connect: jest.fn().mockResolvedValue(client),
      query: jest.fn().mockImplementation((text: string, values?: unknown[]) => {
        queries.push({ text, values });
        if (text.includes('SELECT intake_state')) {
          return Promise.resolve({
            rows: state.initialState === 'absent' ? [] : [{ intake_state: state.initialState }],
            rowCount: state.initialState === 'absent' ? 0 : 1,
            command: 'SELECT', oid: 0, fields: [],
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
      }) as Pool['query'],
    } as Partial<Pool> as Pool,
    queries,
  };
}

function makeIntake(): DomainIntakeService {
  return {
    classifyAndRecommend: jest.fn().mockResolvedValue({
      classification: {
        domain: 'finance',
        confidence: 0.82,
        recommendedTemplate: 'fintech-smb',
        recommendedConnectors: ['stripe', 'plaid'],
      },
      recommendedSeedSkills: ['code-review-pass'],
    }),
  } as unknown as DomainIntakeService;
}

const okSandbox: IRepoSandbox = {
  scan: jest.fn().mockResolvedValue({
    languages: ['typescript'],
    frameworks: ['next.js'],
    fileCount: 1024,
    truncated: false,
    notes: [],
  }),
};

const erroringSandbox: IRepoSandbox = {
  scan: jest.fn().mockRejectedValue(new RepoScanError('wall_clock_exceeded', 'timeout')),
};

describe('PgDomainIntakeProcessor.loadState', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';

  it('returns the current state from the row', async () => {
    const { pool } = makePool({ initialState: 'requested' });
    const proc = new PgDomainIntakeProcessor(pool, makeIntake(), okSandbox);
    expect(await proc.loadState(tenantId)).toBe('requested');
  });

  it("returns 'absent' when no row exists", async () => {
    const { pool } = makePool({ initialState: 'absent' });
    const proc = new PgDomainIntakeProcessor(pool, makeIntake(), okSandbox);
    expect(await proc.loadState(tenantId)).toBe('absent');
  });
});

describe('PgDomainIntakeProcessor.process', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';

  it('throws when state is not requested (CAS misses)', async () => {
    const { pool } = makePool({ initialState: 'complete' });
    const proc = new PgDomainIntakeProcessor(pool, makeIntake(), okSandbox);
    await expect(proc.process(tenantId)).rejects.toThrow(/intake_not_requested/);
  });

  it('drives state requested -> processing -> complete on success', async () => {
    const { pool, queries } = makePool({ initialState: 'requested' });
    const proc = new PgDomainIntakeProcessor(pool, makeIntake(), okSandbox);

    const out = await proc.process(tenantId);
    expect(out.classifiedDomain).toBe('finance');
    expect(out.classifiedConfidence).toBeCloseTo(0.82, 2);
    expect(out.recommendedConnectors).toEqual(['stripe', 'plaid']);

    expect(queries.some((q) => q.text.includes("'processing'"))).toBe(true);
    expect(queries.some((q) => q.text.includes("'complete'"))).toBe(true);
  });

  it('transitions to failed when classifier throws', async () => {
    const { pool, queries } = makePool({ initialState: 'requested' });
    const intake = makeIntake();
    (intake.classifyAndRecommend as jest.Mock).mockRejectedValueOnce(new Error('classifier exploded'));
    const proc = new PgDomainIntakeProcessor(pool, intake, okSandbox);

    await expect(proc.process(tenantId)).rejects.toThrow(/classifier exploded/);
    expect(queries.some((q) => q.text.includes("'failed'"))).toBe(true);
  });

  it('calls the sandbox when repo URL is present in repo_scan_summary', async () => {
    const { pool } = makePool({
      initialState: 'requested',
      repoScanSummary: { repoUrl: 'https://github.com/test/x.git' },
    });
    const proc = new PgDomainIntakeProcessor(pool, makeIntake(), okSandbox);
    await proc.process(tenantId);

    expect((okSandbox.scan as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ repoUrl: 'https://github.com/test/x.git' }),
    );
  });

  it('does not call sandbox when no repo URL is present', async () => {
    const { pool } = makePool({ initialState: 'requested' });
    const sandbox: IRepoSandbox = { scan: jest.fn() };
    const proc = new PgDomainIntakeProcessor(pool, makeIntake(), sandbox);
    await proc.process(tenantId);
    expect(sandbox.scan).not.toHaveBeenCalled();
  });

  it('sandbox failure is non-fatal: completes intake with a note instead of failing', async () => {
    const { pool, queries } = makePool({
      initialState: 'requested',
      repoScanSummary: { repoUrl: 'https://malicious.invalid/x.git' },
    });
    const proc = new PgDomainIntakeProcessor(pool, makeIntake(), erroringSandbox);

    const out = await proc.process(tenantId);
    expect(out.classifiedDomain).toBe('finance');
    expect(queries.some((q) => q.text.includes("'complete'"))).toBe(true);
  });
});
