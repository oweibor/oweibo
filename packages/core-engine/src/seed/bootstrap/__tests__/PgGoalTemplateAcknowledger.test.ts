/**
 * F.5.2 — PgGoalTemplateAcknowledger tests.
 */
import type { Pool, PoolClient, QueryResult } from 'pg';
import { GoalTemplateCatalog, type GoalTemplate } from '../../GoalTemplateCatalog.js';
import { PgGoalTemplateAcknowledger } from '../PgGoalTemplateAcknowledger.js';

function template(id: string, templates: string[], industries?: string[]): GoalTemplate {
  return {
    templateId: id,
    catalogVersion: '2',
    triggerSummary: `${id} trigger`,
    subGoalSkeleton: [{ id: 's1', description: 's1', toolRequest: 'noop' } as never],
    applicableTo: {
      templates,
      ...(industries ? { industries } : {}),
    },
  };
}

function makePool(insertedTemplates: Set<string> = new Set()): {
  pool: Pool;
  queries: { text: string; values?: unknown[] }[];
  } {
  const queries: { text: string; values?: unknown[] }[] = [];
  const fakeClient: Partial<PoolClient> = {
    query: ((text: string, values?: unknown[]): Promise<QueryResult> => {
      queries.push({ text, values });
      if (text.includes('INSERT INTO oweibo.tenant_goal_templates_ack')) {
        const slug = (values as unknown[])[1] as string;
        const isFresh = !insertedTemplates.has(slug);
        if (isFresh) insertedTemplates.add(slug);
        return Promise.resolve({
          rows: [{ xmax: isFresh ? '0' : '12345' }],
          rowCount: 1,
          command: 'INSERT',
          oid: 0,
          fields: [],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
    }) as PoolClient['query'],
    release: jest.fn(),
  };
  return {
    pool: { connect: jest.fn().mockResolvedValue(fakeClient) } as Partial<Pool> as Pool,
    queries,
  };
}

describe('PgGoalTemplateAcknowledger', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';

  it('returns applicableCount=0 when catalog is empty for this tenant', async () => {
    const catalog = GoalTemplateCatalog.fromEntries([
      template('only-fintech', ['fintech-smb']),
    ]);
    const { pool, queries } = makePool();
    const adapter = new PgGoalTemplateAcknowledger(catalog, pool);

    const out = await adapter.acknowledge(tenantId, 'unrelated-template');
    expect(out.applicableCount).toBe(0);
    expect(out.catalogVersion).toBe('empty');
    expect(queries.filter((q) => q.text.includes('INSERT'))).toHaveLength(0);
  });

  it('inserts one ack row per applicable template with the observed catalog version', async () => {
    const catalog = GoalTemplateCatalog.fromEntries([
      template('feature',     ['*']),
      template('maintenance', ['default', 'nextjs-app']),
      template('skipped',     ['fintech-smb']),
    ]);
    const { pool, queries } = makePool();
    const adapter = new PgGoalTemplateAcknowledger(catalog, pool);

    const out = await adapter.acknowledge(tenantId, 'default');
    expect(out.applicableCount).toBe(2);
    expect(out.inserted).toBe(2);
    expect(out.updated).toBe(0);
    expect(out.catalogVersion).toBe('2');

    const inserts = queries.filter((q) => q.text.includes('tenant_goal_templates_ack'));
    expect(inserts).toHaveLength(2);
    expect((inserts[0]!.values as unknown[])[3]).toBe('bootstrap');
  });

  it('idempotent: second call records updates instead of inserts', async () => {
    const catalog = GoalTemplateCatalog.fromEntries([template('feature', ['*'])]);
    const seen = new Set<string>();
    const { pool } = makePool(seen);
    const adapter = new PgGoalTemplateAcknowledger(catalog, pool);

    const first = await adapter.acknowledge(tenantId, 'default');
    expect(first.inserted).toBe(1);
    expect(first.updated).toBe(0);

    const second = await adapter.acknowledge(tenantId, 'default');
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(1);
  });

  it('filters by industry when supplied', async () => {
    const catalog = GoalTemplateCatalog.fromEntries([
      template('fintech-only', ['*'], ['fintech']),
      template('health-only',  ['*'], ['healthcare']),
      template('any-industry', ['*']),
    ]);
    const { pool } = makePool();
    const adapter = new PgGoalTemplateAcknowledger(catalog, pool);

    const out = await adapter.acknowledge(tenantId, 'default', 'fintech');
    expect(out.applicableCount).toBe(2);
  });

  it('sets app.tenant_id GUC inside the transaction for RLS', async () => {
    const catalog = GoalTemplateCatalog.fromEntries([template('feature', ['*'])]);
    const { pool, queries } = makePool();
    const adapter = new PgGoalTemplateAcknowledger(catalog, pool);
    await adapter.acknowledge(tenantId, 'default');

    const guc = queries.find((q) => q.text.includes('SET LOCAL app.tenant_id'));
    expect(guc).toBeDefined();
    expect(guc!.text).toContain(tenantId);
  });
});
