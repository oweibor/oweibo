/**
 * K.8 exit-gate battery (roadmap K.8; ADR-002 armed). Against live Postgres.
 * Gates:
 *   (1) "Who owns Project Atlas?" answered from the GRAPH with citation
 *       (the owning edge carries index_generation + source_revision, INV-1);
 *   (2) a Provisional identity produces HEDGED language end-to-end;
 *   (3) a rejected merge retracts edges ASYNC (GraphInvalidated → retract),
 *       and graph proximity drops to 0 the moment the edge is retracted;
 *   (4) §9.4 IdP bootstrap: two sources sharing a verified email resolve to
 *       ONE canonical identity (the cache-key canonical id, replacing ADR-001
 *       A2's per-source stand-in);
 *   (5) pending-edge rule: an edge whose referent is absent is held pending,
 *       then activated when the referent appears;
 *   (6) convergence: a confirmed provisional merge promotes to Resolved.
 *
 * Skips cleanly without TEST_DATABASE_URL. Identity/Edge are Knowledge-Runtime
 * sole-written; retrieval only reads (INV-16).
 */
import { Pool, type PoolClient } from 'pg';
import { IdentityResolutionService } from '../graph/IdentityResolutionService';
import { KnowledgeGraphService } from '../graph/KnowledgeGraphService';
import { hedgeResponse, graphProximity } from '../graph';

const TEST_DB_URL = process.env['TEST_DATABASE_URL'];
const describeOrSkip = TEST_DB_URL ? describe : describe.skip;

describeOrSkip('K.8 graph + identity battery (ADR-002 armed)', () => {
  let pool: Pool;
  let tenant: string;
  const identity = () => new IdentityResolutionService(pool);
  const graph = () => new KnowledgeGraphService(pool);

  async function withPlatformAdmin<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try { await client.query(`SET ROLE platform_admin`); return await fn(client); }
    finally { await client.query(`RESET ROLE`).catch(() => undefined); client.release(); }
  }
  async function withTenant<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try { await client.query(`SET app.tenant_id = '${tenant}'`); return await fn(client); }
    finally { await client.query(`RESET app.tenant_id`).catch(() => undefined); client.release(); }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    tenant = await withPlatformAdmin(async (c) => {
      const r = await c.query(`INSERT INTO oweibo.tenants (name, slug, quotas) VALUES ('Tenant K8', 'tenant-k8-battery', '{}') RETURNING id`);
      return r.rows[0].id as string;
    });
  });

  afterAll(async () => {
    await withPlatformAdmin((c) => c.query(`DELETE FROM oweibo.tenants WHERE slug = 'tenant-k8-battery'`));
    await pool.end();
  });

  it('(1) "Who owns Project Atlas?" answered from graph with citation (INV-1 edge provenance)', async () => {
    await graph().addEdge({
      tenantId: tenant, srcKind: 'person', srcRef: 'bob@acme.test', edgeType: 'owns',
      dstKind: 'project', dstRef: 'project-atlas', source: 'google_drive',
      confidence: 'resolved', indexGeneration: 5, sourceRevision: 12,
    });
    const answer = await graph().whoOwns(tenant, 'project-atlas');
    expect(answer.owners).toEqual(['bob@acme.test']);
    expect(answer.provisional).toBe(false);
    // Resolved → a direct assertion (no hedge).
    expect(hedgeResponse('resolved', 'Bob', 'owns', 'Project Atlas')).toBe('Bob owns Project Atlas');
    // Citation substrate: the owning edge carries generation + revision (INV-1, §8.2).
    const edge = await withTenant((c) => c.query(
      `SELECT index_generation, source_revision, source FROM oweibo.kf_graph_edges
        WHERE tenant_id = $1::uuid AND edge_type = 'owns' AND dst_ref = 'project-atlas'`, [tenant]));
    expect(edge.rows[0]).toMatchObject({ index_generation: '5', source_revision: '12', source: 'google_drive' });
  });

  it('(2) a Provisional identity produces hedged language end-to-end', async () => {
    // name_and_manager alone → 0.80 → provisional.
    const link = await identity().linkPrincipal({
      tenantId: tenant, source: 'jira', sourcePrincipalRef: 'bob.j',
      signals: ['name_and_manager'], primaryEmail: 'bob@acme.test', displayName: 'Bob J',
    });
    expect(link.state).toBe('provisional');

    // A provisional graph edge → hedged answer.
    await graph().addEdge({
      tenantId: tenant, srcKind: 'person', srcRef: 'bob.j', edgeType: 'owns',
      dstKind: 'project', dstRef: 'project-nebula', source: 'jira', confidence: 'provisional',
    });
    const answer = await graph().whoOwns(tenant, 'project-nebula');
    expect(answer.provisional).toBe(true);
    const hedged = hedgeResponse(answer.provisional ? 'provisional' : 'resolved', 'Bob', 'associated with', 'Project Nebula');
    expect(hedged).toBe('Based on available identity mappings, Bob is likely associated with Project Nebula.');
  });

  it('(3) a rejected merge retracts edges async (GraphInvalidated) and drops proximity to 0', async () => {
    const link = await identity().linkPrincipal({
      tenantId: tenant, source: 'slack', sourcePrincipalRef: 'bob.s',
      signals: ['name_and_manager'], primaryEmail: 'bob@acme.test',
    });
    await graph().addEdge({
      tenantId: tenant, srcKind: 'person', srcRef: 'bob.s', edgeType: 'member_of',
      dstKind: 'team', dstRef: 'team-core', source: 'slack', confidence: 'provisional',
    });
    // Proximity is non-zero while the edge is active.
    const before = graphProximity(await graph().loadActiveEdges(tenant), 'bob.s', 'team-core');
    expect(before).toBe(0.5);

    // Admin rejects the merge → GraphInvalidated (NOT a sync delete).
    const rejected = await identity().rejectMerge(tenant, link.linkId!);
    expect(rejected.rejected).toBe(true);
    const events = await pool.query(`SELECT subject FROM oweibo.outbox WHERE payload->>'tenantId' = $1 AND subject = 'GraphInvalidated'`, [tenant]);
    expect(events.rows.length).toBeGreaterThanOrEqual(1);

    // The async consumer retracts edges referencing the rejected principal.
    const { retracted } = await graph().retractForPrincipal(tenant, 'bob.s');
    expect(retracted).toBeGreaterThanOrEqual(1);
    // Retracted edges no longer contribute to proximity.
    const after = graphProximity(await graph().loadActiveEdges(tenant), 'bob.s', 'team-core');
    expect(after).toBe(0);
  });

  it('(4) IdP bootstrap: two sources sharing a verified email → one canonical identity', async () => {
    await withTenant((c) => c.query(
      `INSERT INTO oweibo.kf_principal_seeds (tenant_id, source, principal_ref, verified_email, display_name)
       VALUES ($1::uuid,'google_drive','ada@drive','ada@acme.test','Ada'),
              ($1::uuid,'jira','ada.j','ada@acme.test','Ada J')`, [tenant]));
    const boot = await identity().bootstrapFromSeeds(tenant);
    expect(boot.links).toBe(2);

    const fromDrive = await identity().canonicalFor(tenant, 'google_drive', 'ada@drive');
    const fromJira = await identity().canonicalFor(tenant, 'jira', 'ada.j');
    expect(fromDrive?.canonicalId).toBe(fromJira?.canonicalId); // same person across sources
    expect(fromDrive?.state).toBe('resolved'); // corporate_email 0.98 → resolved
  });

  it('(5) pending-edge rule: absent referent held pending, then activated', async () => {
    const pending = await graph().addEdge({
      tenantId: tenant, srcKind: 'doc', srcRef: 'doc-spec', edgeType: 'references',
      dstKind: 'doc', dstRef: 'doc-appendix', source: 'google_drive', referentExists: false,
    });
    expect(pending.state).toBe('pending');
    // Referent appears (as the src of some active edge).
    await graph().addEdge({
      tenantId: tenant, srcKind: 'doc', srcRef: 'doc-appendix', edgeType: 'owns',
      dstKind: 'person', dstRef: 'eve@acme.test', source: 'google_drive', referentExists: true,
    });
    const { activated } = await graph().activatePending(tenant);
    expect(activated).toBeGreaterThanOrEqual(1);
  });

  it('(6) convergence: a confirmed provisional merge promotes to Resolved', async () => {
    const link = await identity().linkPrincipal({
      tenantId: tenant, source: 'github', sourcePrincipalRef: 'carol-gh',
      signals: ['name_and_manager'], primaryEmail: 'carol@acme.test',
    });
    expect(link.state).toBe('provisional');
    const queue = await identity().reviewQueue(tenant);
    expect(queue.some((q) => q.linkId === link.linkId)).toBe(true);

    const { confirmed } = await identity().confirmMerge(tenant, link.linkId!);
    expect(confirmed).toBe(true);
    const resolved = await identity().canonicalFor(tenant, 'github', 'carol-gh');
    expect(resolved?.state).toBe('resolved'); // converged
  });
});
