/**
 * F.5.7 — PgProjectSeeder tests.
 */
import type { Pool, PoolClient, QueryResult } from 'pg';
import { PgProjectSeeder } from '../PgProjectSeeder.js';

const sampleSpec = {
  name: 'Default',
  description: 'Starter project',
  invariants: { language: 'typescript', 'test-runner': 'vitest' },
  tags: ['scope:starter', 'seed:starter-project'],
} as const;

interface State {
  insertReturnsId: string | null;
  existingId: string | null;
}

function makePool(state: State): { pool: Pool; queries: { text: string; values?: unknown[] }[] } {
  const queries: { text: string; values?: unknown[] }[] = [];
  const client: Partial<PoolClient> = {
    query: ((text: string, values?: unknown[]): Promise<QueryResult> => {
      queries.push({ text, values });
      if (text.includes('INSERT INTO oweibo.tenant_projects')) {
        if (state.insertReturnsId) {
          return Promise.resolve({
            rows: [{ id: state.insertReturnsId }],
            rowCount: 1, command: 'INSERT', oid: 0, fields: [],
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0, command: 'INSERT', oid: 0, fields: [] });
      }
      if (text.includes('SELECT id FROM oweibo.tenant_projects')) {
        return Promise.resolve({
          rows: state.existingId ? [{ id: state.existingId }] : [],
          rowCount: state.existingId ? 1 : 0, command: 'SELECT', oid: 0, fields: [],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
    }) as PoolClient['query'],
    release: jest.fn(),
  };
  return {
    pool: { connect: jest.fn().mockResolvedValue(client) } as Partial<Pool> as Pool,
    queries,
  };
}

describe('PgProjectSeeder', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';

  it('inserts a new starter project and returns the new id', async () => {
    const { pool, queries } = makePool({ insertReturnsId: 'proj-1', existingId: null });
    const seeder = new PgProjectSeeder(pool);

    const out = await seeder.seedStarterProject(tenantId, sampleSpec);
    expect(out.status).toBe('inserted');
    expect(out.projectId).toBe('proj-1');

    const insert = queries.find((q) => q.text.includes('INSERT INTO oweibo.tenant_projects'));
    expect(insert).toBeDefined();
    const insertValues = insert!.values as unknown[];
    expect(insertValues[0]).toBe(tenantId);
    expect(insertValues[2]).toBe('Default');
    const specJson = JSON.parse(insertValues[3] as string) as Record<string, unknown>;
    expect(specJson['invariants']).toEqual(sampleSpec.invariants);
    expect(specJson['tags']).toEqual(sampleSpec.tags);
  });

  it('returns already_present + existing id on conflict', async () => {
    const { pool } = makePool({ insertReturnsId: null, existingId: 'proj-existing' });
    const seeder = new PgProjectSeeder(pool);

    const out = await seeder.seedStarterProject(tenantId, sampleSpec);
    expect(out.status).toBe('already_present');
    expect(out.projectId).toBe('proj-existing');
  });

  it('honors the template_slug override', async () => {
    const { pool, queries } = makePool({ insertReturnsId: 'proj-2', existingId: null });
    const seeder = new PgProjectSeeder(pool);

    await seeder.seedStarterProject(tenantId, sampleSpec, 'nextjs-app');
    const insert = queries.find((q) => q.text.includes('INSERT INTO oweibo.tenant_projects'));
    expect((insert!.values as unknown[])[1]).toBe('nextjs-app');
  });

  it('uses the unique-starter constraint name for ON CONFLICT', async () => {
    const { pool, queries } = makePool({ insertReturnsId: 'proj-3', existingId: null });
    const seeder = new PgProjectSeeder(pool);
    await seeder.seedStarterProject(tenantId, sampleSpec);
    const insert = queries.find((q) => q.text.includes('INSERT INTO oweibo.tenant_projects'));
    expect(insert!.text).toContain('tenant_projects_unique_starter');
    expect(insert!.text).toContain('DO NOTHING');
  });
});
