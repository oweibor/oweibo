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
 *     approval.
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

export interface ImpactReport {
  readonly classification: ChangeClass;
  readonly dualControlRequired: boolean;
  readonly backfillRequired: boolean;
  readonly affectedDocuments: number;
  readonly pathsChanged: readonly PolicyDimension[];
}

export class TenantPolicyService {
  constructor(private readonly pool: Pool) {}

  private async withTenant<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(`SET app.tenant_id = '${tenantId}'`);
      return await fn(client);
    } finally {
      await client.query(`RESET app.tenant_id`).catch(() => undefined);
      client.release();
    }
  }

  /** The tenant's effective policy — stored rows over §3.1 defaults. */
  async effectivePolicy(tenantId: string): Promise<EffectivePolicy> {
    const rows = await this.withTenant(tenantId, (c) =>
      c.query(
        `SELECT dimension, value FROM oweibo.kf_tenant_policies WHERE tenant_id = $1::uuid`,
        [tenantId],
      ),
    );
    const out: Record<string, PolicyValue> = {};
    for (const d of POLICY_DIMENSIONS) out[d] = POLICY_DEFAULTS[d];
    for (const r of rows.rows) out[r.dimension as string] = r.value as PolicyValue;
    return out as EffectivePolicy;
  }

  /** Current monotonic version; 1 when the tenant has never set a policy. */
  async currentVersion(tenantId: string): Promise<string> {
    const r = await this.withTenant(tenantId, (c) =>
      c.query(
        `SELECT COALESCE(MAX(policy_version), 1) AS v FROM oweibo.kf_tenant_policies WHERE tenant_id = $1::uuid`,
        [tenantId],
      ),
    );
    return String(r.rows[0]?.v ?? '1');
  }

  private async classify(req: PolicyChangeRequest): Promise<ChangeClass> {
    const current = await this.effectivePolicy(req.tenantId);
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
    const classification = await this.classify(req);
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
    const classification = await this.classify(req);
    if (classification === 'no_change') return { kind: 'no_change' };
    if (requiresDualControl(classification)) {
      return {
        kind: 'needs_dual_control',
        classification,
        quorum: POLICY_RELAXATION_FLOOR.quorum,
      };
    }
    return this.commit(req, classification);
  }

  /**
   * §3.4 — apply a relaxation that reached quorum. Quorum is over DISTINCT
   * principals with the proposer counting as at most one, so the proposer alone
   * can never satisfy it.
   */
  async applyApprovedRelaxation(
    req: PolicyChangeRequest,
    votes: readonly RelaxationVote[],
  ): Promise<ApplyResult | { readonly kind: 'rejected'; readonly reason: string }> {
    const classification = await this.classify(req);
    if (classification === 'no_change') return { kind: 'no_change' };
    if (!requiresDualControl(classification)) return this.commit(req, classification);

    const verdict = evaluateQuorum(req.proposerId, votes, POLICY_RELAXATION_FLOOR.quorum);
    if (verdict.kind === 'vetoed') {
      return { kind: 'rejected', reason: `dissent veto by ${verdict.by}` };
    }
    if (verdict.kind === 'pending') {
      return { kind: 'needs_dual_control', classification, quorum: POLICY_RELAXATION_FLOOR.quorum };
    }
    return this.commit(req, classification);
  }

  /**
   * The ONLY write path. Value + version bump in one transaction (§1), then the
   * event AFTER the durable write (INV-5).
   */
  private async commit(req: PolicyChangeRequest, classification: ChangeClass): Promise<ApplyResult> {
    const backfillRequired = requiresBackfill(classification);
    const version = await this.withTenant(req.tenantId, async (c) => {
      await c.query('BEGIN');
      try {
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

        await c.query('COMMIT');
        return next.toString();
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    });

    return { kind: 'applied', policyVersion: version, backfillRequired };
  }
}
