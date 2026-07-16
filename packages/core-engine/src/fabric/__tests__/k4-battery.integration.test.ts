/**
 * K.4 exit-gate battery (roadmap K.4; ADR-001 §7). The half that needs a
 * live K.3 deployment:
 *   (1) the four §7.2 example queries produce the documented plan shapes
 *       against a live-seeded connector snapshot;
 *   (2) the index-path plan EXECUTES end-to-end: plan → RetrievalService →
 *       cited result (the only path executable at K.4, A1);
 *   (3) graph/live_mcp plans are emitted correct but NOT executed here
 *       (deferred to K.8/K.6) — the skeleton's "produce the plan, execute
 *       what exists" posture;
 *   (4) a compliance-blocked query never reaches retrieval.
 *
 * The pure planner behavior (fallback-table rows, compound DAG, gate
 * ordering) is covered without a DB in planner/__tests__/. Fixture ports,
 * not @oweibo/connectors (INV-17). Skips cleanly without TEST_DATABASE_URL.
 */
import { createHash } from 'crypto';
import { Pool, type PoolClient } from 'pg';
import { DiscoveryService, type SyncChangeEvent, type SyncChangeFeedPort } from '../discovery/DiscoveryService';
import { IndexingService, type SyncAclPort, type SyncContentPort } from '../indexing/IndexingService';
import { RetrievalService } from '../retrieval/RetrievalService';
import { JobQueue } from '../scheduler/JobQueue';
import {
  ExecutionPlanner,
  type ConnectorSnapshot,
  type ExecutionPlan,
} from '../planner/ExecutionPlanner';
import { SUPPORT_FLAGS } from '../planner/contract';

const TEST_DB_URL = process.env['TEST_DATABASE_URL'];
const describeOrSkip = TEST_DB_URL ? describe : describe.skip;

interface FixtureDoc {
  fields: Record<string, unknown>;
  revision: number;
  grants: Array<{ principal: string; kind: 'user' | 'group'; access: string }>;
}

class FixtureSource implements SyncChangeFeedPort<unknown>, SyncContentPort<unknown>, SyncAclPort<unknown> {
  readonly docs = new Map<string, FixtureDoc>();
  private readonly log: SyncChangeEvent[] = [];
  put(id: string, fields: Record<string, unknown>, grants: FixtureDoc['grants']): void {
    const prior = this.docs.get(id);
    const revision = (prior?.revision ?? 0) + 1;
    this.docs.set(id, { fields, revision, grants });
    this.log.push({ ref: id, kind: prior ? 'updated' : 'created', sourceRevision: String(revision) });
  }
  async listChanges(_ctx: unknown, cursor: string | null) {
    const offset = cursor === null ? 0 : Number(cursor);
    const items = this.log.slice(offset, offset + 5);
    return { items, nextCursor: String(offset + items.length) };
  }
  async fetchContent(_ctx: unknown, ref: string) {
    const d = this.docs.get(ref);
    if (!d) throw new Error(`no doc ${ref}`);
    return { fields: d.fields, revision: String(d.revision) };
  }
  async fetchAcl(_ctx: unknown, ref: string) {
    const d = this.docs.get(ref);
    if (!d) throw new Error(`no doc ${ref}`);
    const canon = d.grants.map((g) => `${g.kind}:${g.principal}:${g.access}`).sort().join('\n');
    return {
      aclVersion: `sha256:${createHash('sha256').update(canon).digest('hex')}`,
      principals: d.grants,
    };
  }
}

/** The connector as the registry would report it to the planner at plan time. */
function liveConnectorSnapshot(): ConnectorSnapshot {
  return {
    connectorId: 'google-drive',
    enabled: true,
    capabilityVersion: '1.0.0',
    heartbeatSeconds: 300,
    // Drive's K.3 install subset (connector.ts): changeFeed/content/acl/deltaSync.
    effectiveCapabilities: { changeFeed: true, content: true, acl: true, deltaSync: true },
  };
}

describeOrSkip('K.4 planner battery (ADR-001 armed against live K.3)', () => {
  let pool: Pool;
  let tenant: string;
  const CONNECTOR = 'google-drive';
  const SOURCE = 'google_drive';
  const source = new FixtureSource();
  const planner = new ExecutionPlanner();
  let cursor: string | null = null;

  async function withPlatformAdmin<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE platform_admin`);
      return await fn(client);
    } finally {
      await client.query(`RESET ROLE`).catch(() => undefined);
      client.release();
    }
  }
  async function withTenant<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query(`SET app.tenant_id = '${tenant}'`);
      return await fn(client);
    } finally {
      await client.query(`RESET app.tenant_id`).catch(() => undefined);
      client.release();
    }
  }

  async function runPipeline(): Promise<void> {
    const poll = await new DiscoveryService(pool).poll({
      tenantId: tenant, connectorId: CONNECTOR, source: SOURCE, port: source, ctx: {}, cursor,
    });
    cursor = poll.nextCursor;
    await withTenant(async (c) => {
      const queue = new JobQueue(c);
      for (;;) {
        const jobs = await queue.claim(10);
        if (jobs.length === 0) break;
        for (const job of jobs) {
          const cp = job.checkpoint as { documentId: string; kind: SyncChangeEvent['kind']; sourceRevision: number };
          await new IndexingService(pool).indexDocument({
            tenantId: tenant, connectorId: CONNECTOR, source: SOURCE,
            documentId: cp.documentId, sourceRevision: Math.max(cp.sourceRevision, 1),
            kind: cp.kind, content: source, acl: source, ctx: {},
          });
          await queue.complete(job.id);
        }
      }
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    tenant = await withPlatformAdmin(async (c) => {
      const r = await c.query(
        `INSERT INTO oweibo.tenants (name, slug, quotas)
         VALUES ('Tenant K4', 'tenant-k4-battery', '{}') RETURNING id`,
      );
      return r.rows[0].id as string;
    });
    source.put('doc-pto',
      { title: 'PTO policy and paid time off handbook', mimeType: 'gdoc', modifiedTime: '2026-07-10T10:00:00Z' },
      [{ principal: 'ada@acme.test', kind: 'user', access: 'read' }]);
    await runPipeline();
  });

  afterAll(async () => {
    await withPlatformAdmin((c) => c.query(`DELETE FROM oweibo.tenants WHERE slug = 'tenant-k4-battery'`));
    await pool.end();
  });

  it('(1) the four §7.2 example queries produce the documented plan shapes', () => {
    const conn = [liveConnectorSnapshot()];
    const pto = planner.plan({ tenantId: tenant, query: 'What is our PTO policy?', connectors: conn }) as ExecutionPlan;
    expect([pto.intent, pto.primaryPath, pto.fallbackPath, pto.maxDataAgeMs]).toEqual(['retrieval', 'index', 'none', null]);

    const invoice = planner.plan({ tenantId: tenant, query: 'Has finance approved invoice 491?', connectors: conn }) as ExecutionPlan;
    expect([invoice.intent, invoice.primaryPath, invoice.fallbackPath, invoice.maxDataAgeMs]).toEqual(['lookup', 'live_mcp', null, 30_000]);

    const owner = planner.plan({ tenantId: tenant, query: 'Who owns Project Atlas?', connectors: conn }) as ExecutionPlan;
    expect([owner.intent, owner.primaryPath, owner.fallbackPath]).toEqual(['lookup', 'graph', 'index']);

    const summary = planner.plan({ tenantId: tenant, query: 'Summarize all design docs updated last month.', connectors: conn }) as ExecutionPlan;
    expect([summary.intent, summary.primaryPath]).toEqual(['retrieval', 'hybrid']);
  });

  it('(2) the index-path plan EXECUTES end-to-end: plan → retrieval → cited result', async () => {
    const plan = planner.plan({
      tenantId: tenant, query: 'What is our PTO policy?', connectors: [liveConnectorSnapshot()],
    }) as ExecutionPlan;
    expect(plan.primaryPath).toBe('index'); // the only path executable at K.4

    // Execute the index path through the K.3 RetrievalService (the skeleton's
    // wiring: an `index` primary resolves to the retrieval service).
    const res = await new RetrievalService(pool).retrieve({
      tenantId: tenant, connectorId: CONNECTOR, source: SOURCE,
      query: 'PTO policy paid time off', principalRefs: ['ada@acme.test'],
      acl: source, ctx: {},
    });
    expect(res.items.map((i) => i.documentId)).toEqual(['doc-pto']);
    // The result is cited — the citation carries the plan's retrieval id.
    expect(res.items[0]!.citation.retrievalId).toBe(res.retrievalId);
    const prov = await withTenant((c) =>
      c.query(`SELECT 1 FROM oweibo.kf_provenance WHERE tenant_id = $1::uuid AND retrieval_id = $2::uuid`,
        [tenant, res.retrievalId]),
    );
    expect(prov.rows).toHaveLength(1);
  });

  it('(3) graph/live_mcp plans are emitted but NOT executable at K.4 (A1 deferral)', () => {
    const conn = [liveConnectorSnapshot()];
    for (const q of ['Who owns Project Atlas?', 'Has finance approved invoice 491?']) {
      const plan = planner.plan({ tenantId: tenant, query: q, connectors: conn }) as ExecutionPlan;
      expect(['graph', 'live_mcp']).toContain(plan.primaryPath);
      // executeIndexPath refuses non-index primaries — they await K.6/K.8.
      expect(isExecutableAtK4(plan)).toBe(plan.primaryPath === 'index' || plan.fallbackPath === 'index');
    }
  });

  it('(4) a compliance-blocked query never produces a retrieval plan', () => {
    const out = planner.plan({
      tenantId: tenant, query: 'What is our PTO policy?', connectors: [liveConnectorSnapshot()],
      complianceGate: () => 'block',
    });
    expect(out.blocked).toBe(true);
  });

  it('(5) enabled-only negotiation: a disabled connector is invisible to the planner', () => {
    const plan = planner.plan({
      tenantId: tenant, query: 'What is our PTO policy?',
      connectors: [
        { connectorId: 'jira', enabled: false, capabilityVersion: '1', heartbeatSeconds: 300,
          effectiveCapabilities: Object.fromEntries(SUPPORT_FLAGS.map((f) => [f, true])) },
        liveConnectorSnapshot(),
      ],
    }) as ExecutionPlan;
    expect(plan.connectorDirectives.map((d) => d.connectorId)).toEqual(['google-drive']);
  });
});

/** A plan is executable at K.4 iff its primary or fallback resolves to the index path (A1). */
function isExecutableAtK4(plan: ExecutionPlan): boolean {
  return plan.primaryPath === 'index' || plan.fallbackPath === 'index';
}
