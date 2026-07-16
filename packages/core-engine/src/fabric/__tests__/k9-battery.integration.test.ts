/**
 * K.9 exit-gate battery (roadmap K.9). Against live Postgres.
 *
 * INV-17: the engine never imports @oweibo/connectors — so the "three Tier-0
 * connectors drive end-to-end" gate lives where it belongs, in
 * `packages/connectors/src/__tests__/simulation.test.ts` (Slack + GitHub
 * through the SDK simulation environment) + each connector's certification
 * suite. This battery covers the ENGINE-side gates that need no connector:
 *
 *   (2) UPGRADE: a cohort canary mints jobs at the new version (blue/green),
 *       and a rollback re-tags QUEUED jobs to the prior version while leaving a
 *       leased job untouched — in-flight work never crosses versions;
 *   (3) RESTORE DRILL: a per-tenant restore rebuilds re-derivable stores by
 *       re-crawl with checkpoints intact (delta resume, not full re-crawl);
 *   (4) OUTBOUND MCP: one external MCP client retrieves a CITED,
 *       permission-filtered result through the single-surface face;
 *   (5) ADR-006: a compliance relaxation is refused without dual control, and
 *       the compliance gate blocks an excluded-tag write at the storage layer.
 *
 * Skips cleanly without TEST_DATABASE_URL.
 */
import { Pool, type PoolClient } from 'pg';
import { ConnectorUpgradeService } from '../upgrade/ConnectorUpgradeService';
import { planRestore, restoreIsComplete, storesByClass } from '../dr/backupClass';
import { McpServerFace, type McpBackend, type McpPrincipalBinding } from '../mcp/McpServerFace';
import { TenantPolicyService } from '../policy/TenantPolicyService';
import { CompliancePolicyGate } from '../policy/CompliancePolicyGate';

const TEST_DB_URL = process.env['TEST_DATABASE_URL'];
const describeOrSkip = TEST_DB_URL ? describe : describe.skip;

describeOrSkip('K.9 hardening + scale-out battery', () => {
  let pool: Pool;
  let tenant: string;

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
      const r = await c.query(`INSERT INTO oweibo.tenants (name, slug, quotas) VALUES ('Tenant K9', 'tenant-k9-battery', '{}') RETURNING id`);
      return r.rows[0].id as string;
    });
  });

  afterAll(async () => {
    await withPlatformAdmin((c) => c.query(`DELETE FROM oweibo.tenants WHERE slug = 'tenant-k9-battery'`));
    await pool.end();
  });

  it('(2) upgrade: cohort canary mints at the new version; rollback re-tags queued, spares leased', async () => {
    const svc = new ConnectorUpgradeService(pool);
    await svc.register(tenant, 'slack', '1.0.0', 'canary-a');

    // Enqueue one queued + one leased job at the ACTIVE version's world, then canary.
    const queuedId = await withTenant(async (c) => {
      const r = await c.query(
        `INSERT INTO oweibo.kf_jobs (tenant_id, connector_id, job_class, idempotency_key, state, connector_version)
         VALUES ($1::uuid, 'slack', 4, 'k9-q1', 'queued', '2.0.0') RETURNING id`, [tenant]);
      return r.rows[0].id as string;
    });
    const leasedId = await withTenant(async (c) => {
      const r = await c.query(
        `INSERT INTO oweibo.kf_jobs (tenant_id, connector_id, job_class, idempotency_key, state, connector_version)
         VALUES ($1::uuid, 'slack', 4, 'k9-l1', 'leased', '2.0.0') RETURNING id`, [tenant]);
      return r.rows[0].id as string;
    });

    const canary = await svc.beginCanary(tenant, { connectorId: 'slack', targetVersion: '2.0.0', canaryCohort: 'canary-a' });
    expect(canary.ok).toBe(true);
    // A cohort tenant now mints new jobs at the target version (blue/green tag).
    expect(await svc.jobVersionFor(tenant, 'slack')).toBe('2.0.0');

    // Rollback: queued job re-tagged to 1.0.0; leased job untouched.
    const rb = await svc.rollback(tenant, 'slack');
    expect(rb.ok).toBe(true);
    expect(rb.retagged).toBe(1);

    const after = await withTenant((c) => c.query(
      `SELECT id, connector_version FROM oweibo.kf_jobs WHERE id = ANY($1::uuid[])`, [[queuedId, leasedId]]));
    const byId = Object.fromEntries(after.rows.map((r) => [r.id, r.connector_version]));
    expect(byId[queuedId]).toBe('1.0.0');   // re-tagged to prior
    expect(byId[leasedId]).toBe('2.0.0');   // in-flight, spared
    // Back to stable on the prior version.
    expect(await svc.jobVersionFor(tenant, 'slack')).toBe('1.0.0');
  });

  it('(3) restore drill: checkpoints intact ⇒ delta resume, not full re-crawl', () => {
    const mustBackup = storesByClass('must_backup');
    // A complete backup (all must-backup stores present) restores fully and
    // resumes delta.
    const plan = planRestore(mustBackup);
    expect(restoreIsComplete(mustBackup).ok).toBe(true);
    expect(plan.resumeMode).toBe('delta_resume');
    expect(plan.rebuildByRecrawl).toContain('kf_knowledge_objects'); // re-crawled, not restored
    // Dropping the checkpoint store degrades to a full re-crawl (§19 warning).
    expect(planRestore(mustBackup.filter((s) => s !== 'kf_revision_vectors')).resumeMode).toBe('full_recrawl');
  });

  it('(4) outbound MCP: an external client retrieves a CITED, permission-filtered result', async () => {
    // The backend stands in for the planner→retrieval path (the battery proves
    // the FACE contract; RetrievalService's own live proof is the K.3 battery).
    const backend: McpBackend = {
      search: async ({ query, limit }) => {
        expect(limit).toBeLessThanOrEqual(50);
        return [
          {
            knowledgeObjectId: 'ko-atlas', source: 'google_drive', snippet: `re: ${query}`,
            citation: { knowledgeObjectId: 'ko-atlas', source: 'google_drive', indexGeneration: 5, sourceRevision: 12 },
          },
        ];
      },
      fetch: async () => ({ knowledgeObjectId: 'ko-atlas', content: 'body', citation: { knowledgeObjectId: 'ko-atlas', source: 'google_drive' } }),
      act: async () => ({ verdict: 'allowed' as const }),
    };
    const face = new McpServerFace(
      backend,
      { tryConsume: async () => ({ kind: 'allowed' }) },
      { preflight: async () => ({ kind: 'allow' }), record: async () => undefined },
    );
    const binding: McpPrincipalBinding = {
      tenantId: tenant, principalId: 'p-ada', clientId: 'external-claude',
      scopes: ['oweibo:search'], principalRefs: ['ada@acme.test'],
    };
    const r = await face.call(binding, 'oweibo.search', { query: 'who owns Project Atlas' }, 'mcp-req-1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      const hits = r.value as Array<{ citation: { knowledgeObjectId: string; indexGeneration?: unknown } }>;
      expect(hits).toHaveLength(1);
      // The external client got a CITED result (INV-1 provenance).
      expect(hits[0]!.citation.knowledgeObjectId).toBe('ko-atlas');
      expect(hits[0]!.citation.indexGeneration).toBe(5);
    }
    // A client-supplied tenantId is refused (INV-12) — tenant is from the token.
    const bad = await face.call(binding, 'oweibo.search', { query: 'x', tenantId: 'other' }, 'mcp-req-2');
    expect(bad.ok).toBe(false);
  });

  it('(5) ADR-006: relaxation refused without dual control; compliance gate blocks at storage', async () => {
    const policy = new TenantPolicyService(pool);
    // A relaxation (enable a connector) cannot apply single-handed.
    const r = await policy.propose({
      tenantId: tenant, proposerId: crypto.randomUUID(),
      changes: [{ dimension: 'connector_enablement', value: { kind: 'connector_enablement', enabled: { slack: true } } }],
    });
    expect(r.kind).toBe('needs_dual_control');

    // The compliance gate blocks an excluded-tag write, at the storage layer,
    // with no planner in the call path.
    const gate = new CompliancePolicyGate(
      async () => ({
        // Enable the connector so the block below is attributable to the
        // exclusions dimension (absent ⇒ disabled would block first, §3.3).
        connector_enablement: { kind: 'connector_enablement', enabled: { 'google-drive': true } },
        classification_exclusions: { kind: 'classification_exclusions', excludeTags: ['Confidential'] },
      }),
    );
    const verdict = await gate.check({ tenantId: tenant, connectorId: 'google-drive', tags: ['Confidential'] });
    expect(verdict.kind).toBe('block');
    if (verdict.kind === 'block') expect(verdict.dimension).toBe('classification_exclusions');
  });
});
