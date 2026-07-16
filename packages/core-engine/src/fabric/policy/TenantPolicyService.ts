/**
 * ADR-006 §3.4–§3.6 — the tenant policy service. SOLE writer of
 * `oweibo.kf_tenant_policies` (INV-16).
 *
 * Two properties this class exists to guarantee:
 *
 *  1. A value change and its policy_version bump are ONE transaction (§1). The
 *     version is a structural component of the ADR-001 §3.6 cache key, so a
 *     change visible without its bump would serve results computed under the
 *     prior policy — and would be undetectable after the fact. There is no code
 *     path here that writes a value without bumping.
 *
 *  2. A relaxation cannot apply without dual control (§3.4). Classification is
 *     fail-closed (contract.ts): anything not provably a tightening routes to
 *     approval. Classification happens INSIDE the commit transaction, under a
 *     per-tenant advisory lock — a change classified against a stale policy
 *     could otherwise apply as a relaxation of the current one (TOCTOU).
 */
import type { Pool, PoolClient } from 'pg';
import {
  POLICY_DEFAULTS,
  POLICY_DIMENSIONS,
  POLICY_RELAXATION_FLOOR,
  classifyChangeSet,
  evaluateQuorum,
  isCompliance,
  requiresBackfill,
  requiresDualControl,
  type ChangeClass,
  type PolicyDimension,
  type PolicyValue,
  type RelaxationVote,
} from './contract.js';
import type { EffectivePolicy } from './CompliancePolicyGate.js';

export interface PolicyChangeRequest {
  readonly tenantId: string;
  readonly proposerId: string;
  readonly changes: readonly { readonly dimension: PolicyDimension; readonly value: PolicyValue }[];
}

export type ApplyResult =
  | { readonly kind: 'applied'; readonly policyVersion: string; readonly backfillRequired: boolean }
  | { readonly kind: 'no_change' }
  | { readonly kind: 'needs_dual_control'; readonly classification: ChangeClass; readonly quorum: number };

export type RelaxationOutcome = ApplyResult | { readonly kind: 'rejected'; readonly reason: string };

export interface ImpactReport {
  readonly classification: ChangeClass;
  readonly dualControlRequired: boolean;
  readonly backfillRequired: boolean;
  readonly affectedDocuments: number;
  readonly pathsChanged: readonly PolicyDimension[];
}

/** How the caller has authorized a would-be relaxation when commit classifies one. */
type RelaxationAuth =
  | { readonly kind: 'approved' }
  | { readonly kind: 'vetoed'; readonly by: string }
  | { readonly kind: 'pending' };

export class TenantPolicyService {
  constructor(private readonly pool: Pool) {}

  private async withTenant<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async effectivePolicyWith(c: PoolClient, tenantId: string): Promise<EffectivePolicy> {
    const rows = await c.query(
      `SELECT dimension, value FROM oweibo.kf_tenant_policies WHERE tenant_id = $1::uuid`,
      [tenantId],
    );
    const out: Record<string, PolicyValue> = {};
    for (const d of POLICY_DIMENSIONS) out[d] = POLICY_DEFAULTS[d];
    for (const r of rows.rows) out[r.dimension as string] = r.value as PolicyValue;
    return out as EffectivePolicy;
  }

  /** The tenant's effective policy — stored rows over §3.1 defaults. */
  async effectivePolicy(tenantId: string): Promise<EffectivePolicy> {
    return this.withTenant(tenantId, (c) => this.effectivePolicyWith(c, tenantId));
  }

  /**
   * Current monotonic version; '0' when the tenant has never committed a
   * policy. The never-set sentinel MUST differ from the first committed
   * version (1): they are different policies for cache-key purposes, and a
   * shared value would leave pre-change cache entries reachable after the
   * tenant's first policy commit.
   */
  async currentVersion(tenantId: string): Promise<string> {
    const r = await this.withTenant(tenantId, (c) =>
      c.query(
        `SELECT COALESCE(MAX(policy_version), 0) AS v FROM oweibo.kf_tenant_policies WHERE tenant_id = $1::uuid`,
        [tenantId],
      ),
    );
    return String(r.rows[0]?.v ?? '0');
  }

  private classifyAgainst(current: EffectivePolicy, req: PolicyChangeRequest): ChangeClass {
    return classifyChangeSet(
      req.changes.map((c) => ({
        oldValue: current[c.dimension] ?? POLICY_DEFAULTS[c.dimension],
        newValue: c.value,
      })),
    );
  }

  /**
   * §3.6 — dry-run. A PURE read: zero writes, zero events, no version bump.
   * Reports the §3.3 classification and whether dual control would be required,
   * so an admin learns the approval cost BEFORE proposing rather than at submit.
   */
  async simulate(req: PolicyChangeRequest): Promise<ImpactReport> {
    const classification = this.classifyAgainst(await this.effectivePolicy(req.tenantId), req);
    // Affected-document estimate: a tightening may orphan already-indexed content.
    let affected = 0;
    if (classification === 'tightening') {
      const r = await this.withTenant(req.tenantId, (c) =>
        c.query(
          `SELECT COUNT(*)::int AS n FROM oweibo.kf_knowledge_objects WHERE tenant_id = $1::uuid`,
          [req.tenantId],
        ),
      );
      affected = r.rows[0]?.n ?? 0;
    }
    return {
      classification,
      dualControlRequired: requiresDualControl(classification),
      backfillRequired: requiresBackfill(classification),
      affectedDocuments: affected,
      pathsChanged: req.changes.map((c) => c.dimension),
    };
  }

  /**
   * §3.4/§3.5 — propose a change. A tightening applies immediately (single
   * admin) and schedules its MANDATORY backfill. A relaxation is refused here
   * and must go through `applyApprovedRelaxation` with quorum.
   */
  async propose(req: PolicyChangeRequest): Promise<ApplyResult> {
    const r = await this.commit(req, { kind: 'pending' });
    if (r.kind === 'rejected') {
      // Unreachable: 'pending' auth yields needs_dual_control, never rejected.
      throw new Error(`propose: unexpected rejection: ${r.reason}`);
    }
    return r;
  }

  /**
   * §3.4 — apply a relaxation that reached quorum. Quorum is over DISTINCT
   * principals with the proposer counting as at most one, so the proposer alone
   * can never satisfy it. If the change re-classifies as a tightening against
   * the current policy, it applies regardless (quorum is a ceiling, not a gate,
   * for tightenings).
   */
  async applyApprovedRelaxation(
    req: PolicyChangeRequest,
    votes: readonly RelaxationVote[],
  ): Promise<RelaxationOutcome> {
    const verdict = evaluateQuorum(req.proposerId, votes, POLICY_RELAXATION_FLOOR.quorum);
    const auth: RelaxationAuth =
      verdict.kind === 'approved' ? { kind: 'approved' }
      : verdict.kind === 'vetoed' ? { kind: 'vetoed', by: verdict.by }
      : { kind: 'pending' };
    return this.commit(req, auth);
  }

  /**
   * The ONLY write path. Classification, value change, and version bump all in
   * ONE transaction (§1), serialized per tenant by an advisory lock; the event
   * goes in the same transaction, AFTER the durable write (INV-5).
   */
  private async commit(req: PolicyChangeRequest, auth: RelaxationAuth): Promise<RelaxationOutcome> {
    return this.withTenant(req.tenantId, async (c) => {
      // Serialize commits per tenant: classification and the version bump are
      // both read-then-write. Without this, a change classified as a tightening
      // against a stale policy could commit as a relaxation of the current one.
      await c.query(
        `SELECT pg_advisory_xact_lock(hashtext('kf_tenant_policies'), hashtext($1))`,
        [req.tenantId],
      );

      const current = await this.effectivePolicyWith(c, req.tenantId);
      const classification = this.classifyAgainst(current, req);
      if (classification === 'no_change') return { kind: 'no_change' } as const;
      if (requiresDualControl(classification)) {
        if (auth.kind === 'vetoed') {
          return { kind: 'rejected', reason: `dissent veto by ${auth.by}` } as const;
        }
        if (auth.kind !== 'approved') {
          return {
            kind: 'needs_dual_control',
            classification,
            quorum: POLICY_RELAXATION_FLOOR.quorum,
          } as const;
        }
      }
      const backfillRequired = requiresBackfill(classification);

      const cur = await c.query(
        `SELECT COALESCE(MAX(policy_version), 0) AS v FROM oweibo.kf_tenant_policies WHERE tenant_id = $1::uuid`,
        [req.tenantId],
      );
      const next = BigInt(cur.rows[0]?.v ?? 0) + 1n;

      for (const ch of req.changes) {
        await c.query(
          `INSERT INTO oweibo.kf_tenant_policies
             (tenant_id, dimension, category, value, policy_version, effective_from, updated_by)
           VALUES ($1::uuid, $2, $3, $4::jsonb, $5, NOW(), $6::uuid)
           ON CONFLICT (tenant_id, dimension) DO UPDATE
             SET value = EXCLUDED.value,
                 policy_version = EXCLUDED.policy_version,
                 effective_from = EXCLUDED.effective_from,
                 updated_by = EXCLUDED.updated_by`,
          [
            req.tenantId,
            ch.dimension,
            isCompliance(ch.dimension) ? 'compliance' : 'operational',
            JSON.stringify(ch.value),
            next.toString(),
            req.proposerId,
          ],
        );
      }

      // Every dimension shares the tenant's monotonic version, so a bump
      // invalidates the whole cache namespace (§4: over-invalidation is a
      // performance cost; under-invalidation is a correctness bug).
      await c.query(
        `UPDATE oweibo.kf_tenant_policies SET policy_version = $2 WHERE tenant_id = $1::uuid`,
        [req.tenantId, next.toString()],
      );

      // INV-5: the event goes in the SAME transaction as the durable write,
      // never before it.
      await c.query(
        `INSERT INTO oweibo.outbox (subject, payload) VALUES ('PolicyChanged', $1::jsonb)`,
        [
          JSON.stringify({
            tenantId: req.tenantId,
            policyVersion: next.toString(),
            classification,
            backfillRequired,
            dimensions: req.changes.map((c2) => c2.dimension),
          }),
        ],
      );

      return { kind: 'applied', policyVersion: next.toString(), backfillRequired } as const;
    });
  }
}
