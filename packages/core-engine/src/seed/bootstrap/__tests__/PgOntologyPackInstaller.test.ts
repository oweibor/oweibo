/**
 * F.5.6 — PgOntologyPackInstaller tests.
 */
import type { Pool, PoolClient, QueryResult } from 'pg';
import { OntologyPackRegistry } from '../../../domain/OntologyPackRegistry.js';
import type { OntologyPack } from '@oweibo/core-contracts';
import {
  PgOntologyPackInstaller,
  type IOntologyMemoryWriter,
  renderSeeds,
} from '../PgOntologyPackInstaller.js';

function fakePack(slug: string, packVersion: string): OntologyPack {
  return {
    domainSlug: slug as never,
    packVersion,
    registryVersion: '1',
    glossary: [{ term: 'KYC', definition: 'Know your customer', aliases: [], category: 'compliance' }],
    namedEntities: [{ canonicalName: 'SEC', entityType: 'regulator', aliases: [], description: 'US securities regulator' }],
    terminology: [{ preferred: 'customer', deprecated: ['user'], reason: 'precision', enforcement: 'suggest' }],
    disambiguations: [],
    metadata: {
      authoredBy: 'test', reviewedBy: ['test'], authoredAt: '2026-05-30',
      nextReviewDue: '2027-05-30', sourceRefs: [],
    },
  };
}

interface State {
  bindings: string[];
  intakeDomain: string | null;
  installs: { domain_slug: string; pack_version: string }[];
}

function makePool(state: State): { pool: Pool; queries: { text: string; values?: unknown[] }[] } {
  const queries: { text: string; values?: unknown[] }[] = [];
  const client: Partial<PoolClient> = {
    query: ((text: string, values?: unknown[]): Promise<QueryResult> => {
      queries.push({ text, values });
      if (text.includes('FROM oweibo.tenant_domain_binding')) {
        return Promise.resolve({
          rows: state.bindings.map((domain_slug) => ({ domain_slug })),
          rowCount: state.bindings.length,
          command: 'SELECT', oid: 0, fields: [],
        });
      }
      if (text.includes('FROM oweibo.tenant_domain_intake')) {
        return Promise.resolve({
          rows: state.intakeDomain ? [{ classified_domain: state.intakeDomain }] : [],
          rowCount: state.intakeDomain ? 1 : 0,
          command: 'SELECT', oid: 0, fields: [],
        });
      }
      if (text.includes('FROM oweibo.tenant_ontology_install')) {
        return Promise.resolve({
          rows: state.installs,
          rowCount: state.installs.length,
          command: 'SELECT', oid: 0, fields: [],
        });
      }
      if (text.includes('INSERT INTO oweibo.tenant_ontology_install')) {
        return Promise.resolve({ rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] });
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

function mockWriter(): { writer: IOntologyMemoryWriter; seedsWritten: number[]; calls: { tenantId: string; count: number }[] } {
  const seedsWritten: number[] = [];
  const calls: { tenantId: string; count: number }[] = [];
  const writer: IOntologyMemoryWriter = {
    writeSeeds: jest.fn().mockImplementation(async (tenantId: string, seeds) => {
      seedsWritten.push(seeds.length);
      calls.push({ tenantId, count: seeds.length });
      return { inserted: seeds.length };
    }),
  };
  return { writer, seedsWritten, calls };
}

describe('renderSeeds', () => {
  it('produces seeds for glossary + named entities + terminology', () => {
    const pack = fakePack('fintech', '1');
    const seeds = renderSeeds(pack);
    expect(seeds.map((s) => s.kind).sort()).toEqual(['glossary', 'named-entity', 'terminology']);
    expect(seeds.every((s) => s.tags.includes('domain:fintech:ontology'))).toBe(true);
    expect(seeds.every((s) => s.seedId.startsWith('fintech:'))).toBe(true);
  });

  it('terminology seeds list deprecated terms as "avoid"', () => {
    const seeds = renderSeeds(fakePack('fintech', '1'));
    const term = seeds.find((s) => s.kind === 'terminology');
    expect(term?.content).toContain('avoid: user');
    expect(term?.content).toContain('precision');
  });
});

describe('PgOntologyPackInstaller.install', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';

  it('returns empty when no bound domains and no intake', async () => {
    const { pool } = makePool({ bindings: [], intakeDomain: null, installs: [] });
    const { writer } = mockWriter();
    const registry = new OntologyPackRegistry([fakePack('fintech', '1')]);
    const installer = new PgOntologyPackInstaller(pool, registry, writer);

    const out = await installer.install(tenantId);
    expect(out.consideredDomains).toEqual([]);
    expect(out.installed).toEqual([]);
    expect(writer.writeSeeds).not.toHaveBeenCalled();
  });

  it('falls back to intake classified_domain when no D.6 bindings exist', async () => {
    const { pool } = makePool({ bindings: [], intakeDomain: 'fintech', installs: [] });
    const { writer, seedsWritten } = mockWriter();
    const registry = new OntologyPackRegistry([fakePack('fintech', '1')]);
    const installer = new PgOntologyPackInstaller(pool, registry, writer);

    const out = await installer.install(tenantId);
    expect(out.consideredDomains).toEqual(['fintech']);
    expect(out.installed).toHaveLength(1);
    expect(out.installed[0]!.entryCount).toBe(3);
    expect(seedsWritten).toEqual([3]);
  });

  it('prefers D.6 bindings over intake', async () => {
    const { pool } = makePool({ bindings: ['fintech', 'legal'], intakeDomain: 'healthcare', installs: [] });
    const { writer } = mockWriter();
    const registry = new OntologyPackRegistry([fakePack('fintech', '1'), fakePack('legal', '1')]);
    const installer = new PgOntologyPackInstaller(pool, registry, writer);

    const out = await installer.install(tenantId);
    expect(out.consideredDomains.sort()).toEqual(['fintech', 'legal']);
  });

  it('idempotent: skips domains already at the current pack_version', async () => {
    const { pool } = makePool({
      bindings: ['fintech', 'legal'],
      intakeDomain: null,
      installs: [{ domain_slug: 'fintech', pack_version: '1' }],
    });
    const { writer, calls } = mockWriter();
    const registry = new OntologyPackRegistry([fakePack('fintech', '1'), fakePack('legal', '1')]);
    const installer = new PgOntologyPackInstaller(pool, registry, writer);

    const out = await installer.install(tenantId);
    expect(out.alreadyCurrent).toEqual(['fintech']);
    expect(out.installed.map((i) => i.domainSlug)).toEqual(['legal']);
    expect(calls).toHaveLength(1);
  });

  it('re-installs when pack version has bumped', async () => {
    const { pool } = makePool({
      bindings: ['fintech'],
      intakeDomain: null,
      installs: [{ domain_slug: 'fintech', pack_version: '0' }],
    });
    const { writer } = mockWriter();
    const registry = new OntologyPackRegistry([fakePack('fintech', '1')]);
    const installer = new PgOntologyPackInstaller(pool, registry, writer);

    const out = await installer.install(tenantId);
    expect(out.installed).toHaveLength(1);
    expect(out.alreadyCurrent).toEqual([]);
  });

  it('skips domains the registry doesnt ship a pack for', async () => {
    const { pool } = makePool({ bindings: ['ml-research'], intakeDomain: null, installs: [] });
    const { writer } = mockWriter();
    const registry = new OntologyPackRegistry([fakePack('fintech', '1')]);
    const installer = new PgOntologyPackInstaller(pool, registry, writer);

    const out = await installer.install(tenantId);
    expect(out.consideredDomains).toEqual(['ml-research']);
    expect(out.installed).toEqual([]);
    expect(writer.writeSeeds).not.toHaveBeenCalled();
  });
});
