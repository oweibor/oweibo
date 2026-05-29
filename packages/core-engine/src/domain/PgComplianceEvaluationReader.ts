/**
 * F.4.5: PgComplianceEvaluationReader — read-side accessor over
 * `oweibo.compliance_rule_evaluations`. Writes happen inline from
 * ActionTrustLadder.gate (fire-and-forget); this service surfaces the
 * rows to the admin compliance evaluations page.
 *
 * Runs under tenant RLS scope (`SET LOCAL app.tenant_id`). Rows whose
 * verdict is 'pass' are omitted by default — the admin surface cares
 * about noteworthy outcomes (info/warn/block/bypass).
 */
import type { Pool } from 'pg';

export type ComplianceEvaluationVerdict = 'pass' | 'info' | 'warn' | 'block' | 'bypass';
export type ComplianceEvaluationPhase = 'action_time' | 'artifact_time';

export interface ComplianceEvaluationRow {
  readonly id: string;
  readonly proposalId: string | null;
  readonly ruleId: string;
  readonly domainSlug: string | null;
  readonly packVersion: string;
  readonly enforcementPhase: ComplianceEvaluationPhase;
  readonly verdict: ComplianceEvaluationVerdict;
  readonly details: Record<string, unknown>;
  readonly bypassPrincipal: string | null;
  readonly bypassReason: string | null;
  readonly evaluatedAt: string;
}

export interface ListEvaluationsOptions {
  /** Verdict filter. Defaults to the noteworthy set. */
  readonly verdicts?: readonly ComplianceEvaluationVerdict[];
  /** Cursor — most-recent evaluated_at older than this. */
  readonly cursor?: string;
  /** Result cap (1..200). Default 50. */
  readonly limit?: number;
}

export class PgComplianceEvaluationReader {
  constructor(private readonly pool: Pool) {}

  async listForTenant(
    tenantId: string,
    opts: ListEvaluationsOptions = {},
  ): Promise<{
    rows: readonly ComplianceEvaluationRow[];
    nextCursor: string | null;
  }> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const verdicts = opts.verdicts ?? ['info', 'warn', 'block', 'bypass'];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (/^[0-9a-f-]{36}$/i.test(tenantId)) {
        await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
      }
      const r = await client.query<{
        id: string;
        proposal_id: string | null;
        rule_id: string;
        domain_slug: string | null;
        pack_version: string;
        enforcement_phase: ComplianceEvaluationPhase;
        verdict: ComplianceEvaluationVerdict;
        details: Record<string, unknown>;
        bypass_principal: string | null;
        bypass_reason: string | null;
        evaluated_at: Date;
      }>(
        `SELECT id, proposal_id, rule_id, domain_slug, pack_version,
                enforcement_phase, verdict, details,
                bypass_principal, bypass_reason, evaluated_at
           FROM oweibo.compliance_rule_evaluations
          WHERE verdict = ANY($1::text[])
            AND ($2::timestamptz IS NULL OR evaluated_at < $2::timestamptz)
          ORDER BY evaluated_at DESC
          LIMIT $3`,
        [verdicts, opts.cursor ?? null, limit + 1],
      );
      await client.query('COMMIT');
      const rows = r.rows.slice(0, limit).map((row) => ({
        id: row.id,
        proposalId: row.proposal_id,
        ruleId: row.rule_id,
        domainSlug: row.domain_slug,
        packVersion: row.pack_version,
        enforcementPhase: row.enforcement_phase,
        verdict: row.verdict,
        details: row.details,
        bypassPrincipal: row.bypass_principal,
        bypassReason: row.bypass_reason,
        evaluatedAt: row.evaluated_at.toISOString(),
      }));
      const nextCursor = r.rows.length > limit
        ? rows[rows.length - 1]?.evaluatedAt ?? null
        : null;
      return { rows, nextCursor };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
