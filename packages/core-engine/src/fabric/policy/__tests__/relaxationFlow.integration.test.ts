/**
 * ADR-006 §3.4 — the relaxation-approval leg, LIVE end-to-end through the
 * shipped machinery: TenantPolicyService (classify + apply) +
 * PolicyRelaxationProposals (durable ballot in action_proposals) +
 * MultiPartyApprovalService.castVote (the approval_votes ledger).
 *
 * The §22 story under test, with real principals:
 *   1. Admin A proposes a relaxation → a pending ballot, policy unchanged.
 *   2. Admin A approves their own ballot → still pending (the proposer
 *      counts as at most one; the proposer ALONE can never satisfy quorum).
 *   3. Admin B approves → quorum → the relaxation APPLIES in the same call:
 *      version bumps, effective policy changes, ballot resolves 'promoted'.
 *   4. Dissent path: one approve + one reject → vetoed, ballot 'rejected',
 *      policy untouched.
 *   5. Floor: a weak tenant policy row for the reserved class is refused
 *      (PolicyBelowFloorError), and a grant for the class is unmintable.
 *   6. Delegated votes never count toward relaxation quorum, even when a
 *      via_delegation row sits in the ledger.
 *
 * Skips cleanly without TEST_DATABASE_URL.
 */
import { Pool, type PoolClient } from 'pg';
import { TenantPolicyService } from '../TenantPolicyService';
import { PolicyRelaxationFlow } from '../PolicyRelaxationFlow';
import { PolicyRelaxationProposals } from '../../../action/PolicyRelaxationProposals';
import { MultiPartyApprovalService } from '../../../action/MultiPartyApprovalService';
import { PolicyBelowFloorError } from '../../../action/PolicyFloor';
import type { PolicyValue } from '../contract';

const TEST_DB_URL = process.env['TEST_DATABASE_URL'];
const describeOrSkip = TEST_DB_URL ? describe : describe.skip;

const scope = (s: 'metadata' | 'full_content'): PolicyValue => ({ kind: 'indexing_scope', scope: s });
const persistence = (allowed: boolean): PolicyValue => ({ kind: 'data_persistence', allowed });

describeOrSkip('ADR-006 §3.4 — relaxation ballots through the multi-party ledger (live)', () => {
  let pool: Pool;
  let tenant: string;
  let adminA: string;
  let adminB: string;
  let adminC: string;

  const policy = () => new TenantPolicyService(pool);
  const flow = () =>
    new PolicyRelaxationFlow(policy(), new PolicyRelaxationProposals(pool), new MultiPartyApprovalService(pool));

  async function withPlatformAdmin<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try { await client.query(`SET ROLE platform_admin`); return await fn(client); }
    finally { await client.query(`RESET ROLE`).catch(() => undefined); client.release(); }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    ({ tenant, adminA, adminB, adminC } = await withPlatformAdmin(async (c) => {
      const t = await c.query(
        `INSERT INTO oweibo.tenants (name, slug, quotas) VALUES ('Tenant RelaxFlow', 'tenant-relaxflow-battery', '{}') RETURNING id`,
      );
      const mk = async (email: string) =>
        (await c.query(`INSERT INTO oweibo.users (id, email) VALUES (gen_random_uuid(), $1) RETURNING id`, [email]))
          .rows[0].id as string;
      return {
        tenant: t.rows[0].id as string,
        adminA: await mk('relaxflow-a@acme.test'),
        adminB: await mk('relaxflow-b@acme.test'),
        adminC: await mk('relaxflow-c@acme.test'),
      };
    }));
  });

  afterAll(async () => {
    await withPlatformAdmin(async (c) => {
      await c.query(`DELETE FROM oweibo.tenants WHERE slug = 'tenant-relaxflow-battery'`);
      await c.query(`DELETE FROM oweibo.users WHERE email LIKE 'relaxflow-%@acme.test'`);
    });
    await pool.end();
  });

  it('(1) full approve loop: propose → proposer alone insufficient → second admin approves → applied', async () => {
    const f = flow();
    const versionBefore = await policy().currentVersion(tenant);

    // Propose full_content (a relaxation from the metadata default).
    const proposed = await f.propose({
      tenantId: tenant, proposerId: adminA,
      changes: [{ dimension: 'indexing_scope', value: scope('full_content') }],
    });
    expect(proposed.kind).toBe('pending_approval');
    const proposalId = (proposed as { proposalId: string }).proposalId;

    // Policy is UNCHANGED while the ballot is open (§3.4 rule 4: no provisional apply).
    expect(await policy().currentVersion(tenant)).toBe(versionBefore);

    // The proposer approving their own ballot does not reach quorum.
    const selfVote = await f.vote({ tenantId: tenant, proposalId, voterUserId: adminA, vote: 'approve' });
    expect(selfVote.kind).toBe('pending');
    expect(await policy().currentVersion(tenant)).toBe(versionBefore);

    // The second authorized approver — quorum, and the apply happens HERE.
    const secondVote = await f.vote({ tenantId: tenant, proposalId, voterUserId: adminB, vote: 'approve' });
    expect(secondVote.kind).toBe('applied');
    if (secondVote.kind === 'applied') {
      expect(BigInt(secondVote.policyVersion)).toBeGreaterThan(BigInt(versionBefore));
    }

    const effective = await policy().effectivePolicy(tenant);
    expect(effective.indexing_scope).toEqual(scope('full_content'));

    const status = await f.status(tenant, proposalId);
    expect(status?.proposal.state).toBe('promoted');

    // Voting on a resolved ballot is refused.
    const late = await f.vote({ tenantId: tenant, proposalId, voterUserId: adminC, vote: 'approve' });
    expect(late.kind).toBe('already_resolved');
  });

  it('(2) dissent veto: one approve + one reject → rejected, policy untouched', async () => {
    const f = flow();
    const versionBefore = await policy().currentVersion(tenant);

    const proposed = await f.propose({
      tenantId: tenant, proposerId: adminA,
      changes: [{ dimension: 'data_persistence', value: persistence(true) }],
    });
    // data_persistence default is allowed=true → propose a REAL relaxation
    // instead: first tighten to false (single-admin), then propose true.
    if (proposed.kind === 'no_change') {
      const tighten = await policy().propose({
        tenantId: tenant, proposerId: adminA,
        changes: [{ dimension: 'data_persistence', value: persistence(false) }],
      });
      expect(tighten.kind).toBe('applied');
    }
    const reProposed = await f.propose({
      tenantId: tenant, proposerId: adminA,
      changes: [{ dimension: 'data_persistence', value: persistence(true) }],
    });
    expect(reProposed.kind).toBe('pending_approval');
    const proposalId = (reProposed as { proposalId: string }).proposalId;

    await f.vote({ tenantId: tenant, proposalId, voterUserId: adminA, vote: 'approve' });
    const dissent = await f.vote({ tenantId: tenant, proposalId, voterUserId: adminB, vote: 'reject' });
    expect(dissent.kind).toBe('vetoed');
    if (dissent.kind === 'vetoed') expect(dissent.by).toBe(adminB);

    const status = await f.status(tenant, proposalId);
    expect(status?.proposal.state).toBe('rejected');
    // The tightened value still holds — the veto blocked the re-relaxation.
    const effective = await policy().effectivePolicy(tenant);
    expect(effective.data_persistence).toEqual(persistence(false));
    expect(BigInt(await policy().currentVersion(tenant))).toBeGreaterThanOrEqual(BigInt(versionBefore));
  });

  it('(3) floor: a weak reserved-class policy row is refused, and a grant is unmintable', async () => {
    const mp = new MultiPartyApprovalService(pool);

    await expect(
      mp.upsertPolicy(tenant, 'governance.policy_relaxation', {
        quorum: 2, dissentVetoes: true,
        allowGrants: true, // ← the §3.4 rule-1 violation
        maxGrantDurationSeconds: 3600, maxGrantActionCount: 1,
        allowDelegation: false,
      }),
    ).rejects.toThrow(PolicyBelowFloorError);

    await expect(
      mp.createGrant({
        tenantId: tenant,
        actionClass: 'governance.policy_relaxation' as never,
        grantedByUserIds: [adminA, adminB],
        grantedToKind: 'user',
        grantedToUserId: adminC,
        durationSeconds: 600,
        maxUses: 1,
      } as never),
    ).rejects.toThrow(PolicyBelowFloorError);
  });

  it('(4) delegated votes NEVER count toward relaxation quorum', async () => {
    const f = flow();
    // Fresh relaxation ballot (persistence false → true again).
    const proposed = await f.propose({
      tenantId: tenant, proposerId: adminA,
      changes: [{ dimension: 'data_persistence', value: persistence(true) }],
    });
    expect(proposed.kind).toBe('pending_approval');
    const proposalId = (proposed as { proposalId: string }).proposalId;

    // Admin A approves; then a DELEGATED approve lands in the ledger for
    // admin C (inserted directly — the flow's own surface refuses
    // delegation, so this simulates the generic vote path being abused).
    await f.vote({ tenantId: tenant, proposalId, voterUserId: adminA, vote: 'approve' });
    await withPlatformAdmin((c) =>
      c.query(
        `INSERT INTO oweibo.approval_votes
           (proposal_id, voter_user_id, tenant_id, vote, via_delegation, delegator_user_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'approve', true, $4::uuid)`,
        [proposalId, adminC, tenant, adminB],
      ),
    );

    // Two approve rows exist — but the delegated one is excluded, so the
    // ballot MUST still be pending (1 eligible approver < quorum 2).
    const status = await f.status(tenant, proposalId);
    expect(status?.votes).toHaveLength(2);
    expect(status?.approvals).toBe(1);
    expect(status?.proposal.state).toBe('pending');

    // A real second approval still works after the noise.
    const applied = await f.vote({ tenantId: tenant, proposalId, voterUserId: adminB, vote: 'approve' });
    expect(applied.kind).toBe('applied');
  });
});
