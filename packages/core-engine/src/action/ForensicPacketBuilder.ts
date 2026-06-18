/**
 * S.7: ForensicPacketBuilder — gathers every artifact tied to a plan
 * (proposals, executions, verifications, rollbacks, content inspections)
 * and serializes them into a single signed packet that the operator
 * (or an external auditor) can replay.
 *
 * The builder runs under platform_admin scope inside the tx so it can
 * read the action_lineage tree across whichever tenant the packet
 * belongs to (the calling service has already authenticated the
 * operator's right to do this).
 *
 * PII redaction is applied at packet construction time — values for
 * `payload`, `expected`, `observed`, and `diff` JSON columns pass
 * through a redactor before serialization. The redactor is pluggable;
 * the default uses the GenericPiiInspector's pattern set.
 */
import { createHash } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  ActionProposalSnapshot,
  ExecutionRecord,
  ForensicPacket,
  ForensicTriggerKind,
  IForensicPacketStorage,
  InspectionRecord,
  IPacketSigner,
  RollbackRecord,
  VerificationRecord,
} from '@oweibo/core-contracts';
import { FORENSIC_PACKET_SCHEMA_VERSION } from '@oweibo/core-contracts';

export interface IPiiRedactor {
  /** Returns a structurally-similar value with high-confidence PII redacted. */
  redact(value: unknown): unknown;
}

export interface ForensicPacketBuilderOptions {
  /** Override clock; tests pin time. */
  now?: () => Date;
  /** If supplied, payload + expected/observed values pass through this redactor. */
  redactor?: IPiiRedactor;
}

export class ForensicPacketBuilder {
  private readonly now: () => Date;
  private readonly redactor: IPiiRedactor;

  constructor(
    private readonly pool: Pool,
    public readonly storage: IForensicPacketStorage,
    public readonly signer: IPacketSigner,
    opts: ForensicPacketBuilderOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.redactor = opts.redactor ?? new DefaultPiiRedactor();
  }

  /**
   * Build a packet for `planId` in `tenantId`, sign it, upload bytes
   * to object storage, and return both the packet and the storage
   * metadata for the calling service (HitlHandoffService) to persist
   * into oweibo.forensic_packets.
   */
  async build(args: {
    readonly tenantId: string;
    readonly planId: string;
    readonly triggerKind: ForensicTriggerKind;
    readonly triggeredBy: string;
    readonly summary?: string;
  }): Promise<{
    packet: ForensicPacket;
    storageRef: string;
    signature: string;
    byteSize: number;
  }> {
    const packetId = generatePacketId(args.tenantId, args.planId, this.now().getTime());

    const client = await this.pool.connect();
    let proposals: ActionProposalSnapshot[];
    let executions: ExecutionRecord[];
    let verifications: VerificationRecord[];
    let rollbacks: RollbackRecord[];
    let inspections: InspectionRecord[];
    let originalGoal: string;
    try {
      await client.query('BEGIN');
      // Platform admin scope so cross-tenant compliance review works; the
      // caller is responsible for authorization. Every load* query MUST
      // still filter by tenant_id explicitly — running as platform_admin
      // bypasses RLS, so an unscoped query would leak across tenants.
      await client.query(`SET LOCAL ROLE platform_admin`).catch(() => undefined);

      [proposals, originalGoal] = await this.loadProposalsAndGoal(client, args.tenantId, args.planId);
      const actionIds = proposals.map((p) => p.proposalId);
      executions = await this.loadExecutions(client, actionIds, proposals);
      verifications = await this.loadVerifications(client, args.tenantId, actionIds);
      rollbacks = await this.loadRollbacks(client, args.tenantId, actionIds);
      inspections = await this.loadInspections(client, args.tenantId, actionIds, proposals);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    // String fields can carry PII too (operators paste account IDs into
    // rejection reasons, decision notes, etc.). Stringify-then-redact gives
    // us the same pattern coverage as the JSON path.
    const redactStr = (s: string): string => {
      const r = this.redactor.redact(s);
      return typeof r === 'string' ? r : JSON.stringify(r);
    };

    const packet: ForensicPacket = {
      packetId,
      tenantId: args.tenantId,
      planId: args.planId,
      summary: redactStr(args.summary ?? `Forensic packet for plan ${args.planId}`),
      triggerKind: args.triggerKind,
      triggeredBy: args.triggeredBy,
      originalGoal: redactStr(originalGoal),
      proposals: proposals.map((p) => ({
        ...p,
        summary: redactStr(p.summary),
        decisionReason: p.decisionReason !== null ? redactStr(p.decisionReason) : null,
        payload: this.redactor.redact(p.payload),
      })),
      executions,
      verifications: verifications.map((v) => ({
        ...v,
        expected: this.redactor.redact(v.expected),
        observed: this.redactor.redact(v.observed),
      })),
      rollbacks: rollbacks.map((r) => ({
        ...r,
        reason: redactStr(r.reason),
      })),
      inspections: inspections.map((i) => ({
        ...i,
        reason: i.reason !== null ? redactStr(i.reason) : null,
      })),
      contextSnapshots: {},
      suggestedActions: deriveSuggestions(executions, verifications, rollbacks),
      builtAtMs: this.now().getTime(),
      schemaVersion: FORENSIC_PACKET_SCHEMA_VERSION,
    };

    const bytes = Buffer.from(JSON.stringify(packet), 'utf8');
    const signature = await this.signer.sign(bytes);
    const { storageRef } = await this.storage.put({
      tenantId: args.tenantId,
      packetId,
      bytes,
    });

    return { packet, storageRef, signature, byteSize: bytes.length };
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async loadProposalsAndGoal(
    client: PoolClient, tenantId: string, planId: string,
  ): Promise<[ActionProposalSnapshot[], string]> {
    // S.0: action_plans carries the originating goal; sibling proposals
    // join on plan_id. Audit-fix: filter by tenant_id even though we run
    // as platform_admin — otherwise a caller passing a planId from
    // another tenant would leak that tenant's data into this packet.
    const planRow = await client.query<{ goal: string | null; summary: string | null }>(
      `SELECT goal, summary FROM oweibo.action_plans
        WHERE id = $1::uuid AND tenant_id = $2::uuid`,
      [planId, tenantId],
    );
    if (planRow.rows.length === 0) {
      throw new Error(
        `ForensicPacketBuilder: plan ${planId} not found for tenant ${tenantId}`,
      );
    }
    const originalGoal = planRow.rows[0]?.goal ?? planRow.rows[0]?.summary ?? '<no goal recorded>';

    const propRows = await client.query<{
      id: string;
      action_class: string;
      action_id: string;
      mode: string;
      state: string;
      summary: string;
      payload: unknown;
      rollback_kind: string | null;
      grant_id: string | null;
      created_at: Date;
      decided_at: Date | null;
      decision_reason: string | null;
    }>(
      `SELECT id, action_class, action_id, mode, state, summary, payload,
              rollback_kind, grant_id, created_at, decided_at, decision_reason
         FROM oweibo.action_proposals
        WHERE plan_id = $1::uuid AND tenant_id = $2::uuid
        ORDER BY created_at ASC`,
      [planId, tenantId],
    );
    const proposals = propRows.rows.map<ActionProposalSnapshot>((r) => ({
      proposalId: r.id,
      actionClass: r.action_class,
      actionId: r.action_id,
      mode: r.mode as ActionProposalSnapshot['mode'],
      state: r.state,
      summary: r.summary,
      payload: r.payload,
      rollbackKind: r.rollback_kind,
      grantId: r.grant_id,
      createdAt: r.created_at.toISOString(),
      decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
      decisionReason: r.decision_reason,
    }));
    return [proposals, originalGoal];
  }

  private async loadExecutions(
    client: PoolClient, proposalIds: readonly string[], proposals: readonly ActionProposalSnapshot[],
  ): Promise<ExecutionRecord[]> {
    // T.−1 doesn't keep a dedicated execution row — state transitions
    // on action_proposals carry the outcome. Synthesize records from
    // proposal state.
    void client; void proposalIds;
    const out: ExecutionRecord[] = [];
    for (const p of proposals) {
      if (p.state === 'executed_live' || p.state === 'executed_shadow') {
        out.push({
          proposalId: p.proposalId,
          actionClass: p.actionClass,
          outcome: 'success',
          executedAt: p.decidedAt ?? p.createdAt,
        });
      } else if (p.state === 'rejected' || p.state === 'rollback_failed') {
        out.push({
          proposalId: p.proposalId,
          actionClass: p.actionClass,
          outcome: 'failure',
          executedAt: p.decidedAt ?? p.createdAt,
        });
      }
    }
    return out;
  }

  private async loadVerifications(
    client: PoolClient, tenantId: string, proposalIds: readonly string[],
  ): Promise<VerificationRecord[]> {
    if (proposalIds.length === 0) return [];
    const r = await client.query<{
      proposal_id: string;
      verifier_name: string;
      timing: string;
      drift_severity: number;
      expected: unknown;
      observed: unknown;
      verified_at: Date;
    }>(
      `SELECT proposal_id, verifier_name, timing, drift_severity,
              expected, observed, verified_at
         FROM oweibo.post_execution_verifications
        WHERE proposal_id = ANY($1::uuid[]) AND tenant_id = $2::uuid
        ORDER BY verified_at ASC`,
      [proposalIds, tenantId],
    );
    return r.rows.map<VerificationRecord>((row) => ({
      proposalId: row.proposal_id,
      verifierName: row.verifier_name,
      timing: row.timing as 'immediate' | 'deferred',
      driftSeverity: row.drift_severity as 0 | 1 | 2 | 3,
      expected: row.expected,
      observed: row.observed,
      verifiedAt: row.verified_at.toISOString(),
    }));
  }

  private async loadRollbacks(
    client: PoolClient, tenantId: string, proposalIds: readonly string[],
  ): Promise<RollbackRecord[]> {
    if (proposalIds.length === 0) return [];
    const r = await client.query<{
      original_action_id: string;
      adapter_name: string;
      reason: string;
      result_state: string | null;
      started_at: Date;
      completed_at: Date | null;
    }>(
      `SELECT original_action_id, adapter_name, reason, result_state,
              started_at, completed_at
         FROM oweibo.rollback_executions
        WHERE original_action_id = ANY($1::uuid[]) AND tenant_id = $2::uuid
        ORDER BY started_at ASC`,
      [proposalIds, tenantId],
    );
    return r.rows.map<RollbackRecord>((row) => ({
      originalActionId: row.original_action_id,
      adapterName: row.adapter_name,
      reason: row.reason,
      resultState: row.result_state,
      startedAt: row.started_at.toISOString(),
      completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    }));
  }

  private async loadInspections(
    client: PoolClient, tenantId: string, proposalIds: readonly string[], proposals: readonly ActionProposalSnapshot[],
  ): Promise<InspectionRecord[]> {
    if (proposalIds.length === 0 && proposals.length === 0) return [];
    // content_inspection_results may have null proposal_id (when the
    // gate returned execute and skipped writing a proposal row); we
    // still want them indexed by action_id. Audit-fix: tenant_id is
    // required since the action_id branch is text and could in principle
    // collide across tenants (SHA256-truncated).
    const actionIds = proposals.map((p) => p.actionId);
    const r = await client.query<{
      proposal_id: string | null;
      inspector_name: string;
      verdict: string;
      reason: string | null;
      inspected_at: Date;
    }>(
      `SELECT proposal_id, inspector_name, verdict, reason, inspected_at
         FROM oweibo.content_inspection_results
        WHERE tenant_id = $3::uuid
          AND (proposal_id = ANY($1::uuid[]) OR action_id = ANY($2::text[]))
        ORDER BY inspected_at ASC`,
      [proposalIds, actionIds, tenantId],
    );
    return r.rows.map<InspectionRecord>((row) => ({
      proposalId: row.proposal_id,
      inspectorName: row.inspector_name,
      verdict: row.verdict as 'allow' | 'upgrade_to_approval' | 'forbid',
      reason: row.reason,
      inspectedAt: row.inspected_at.toISOString(),
    }));
  }
}

// ── Default PII redactor ─────────────────────────────────────────────────

/**
 * Stringifies the input, replaces high-confidence PII (SSN, Luhn-valid
 * cards, common API keys), and re-parses. Falls back to '<redacted>'
 * when the input can't be safely round-tripped.
 */
export class DefaultPiiRedactor implements IPiiRedactor {
  redact(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    let s: string;
    try {
      s = JSON.stringify(value);
    } catch {
      return '<redacted>';
    }
    let redacted = s;
    // High-confidence patterns from GenericPiiInspector.
    // NOTE: replacements must NOT introduce JSON-breaking characters
    // (quotes, backslashes) because the redactor JSON.parses the result.
    // The patterns below are bare identifiers — safe to splice into a
    // JSON string literal.
    redacted = redacted.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '<REDACTED:SSN>');
    redacted = redacted.replace(/\bAKIA[0-9A-Z]{16}\b/g, '<REDACTED:AWS_KEY>');
    redacted = redacted.replace(/\bghp_[A-Za-z0-9]{36}\b/g, '<REDACTED:GITHUB_PAT>');
    redacted = redacted.replace(/\bsk-[A-Za-z0-9]{32,}\b/g, '<REDACTED:OPENAI_KEY>');
    redacted = redacted.replace(/\bxox[bpoas]-[A-Za-z0-9-]{10,}\b/g, '<REDACTED:SLACK_TOKEN>');
    // CC numbers: replace any 13-19 digit run that passes Luhn.
    redacted = redacted.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
      const digits = m.replace(/[^\d]/g, '');
      if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) {
        return '<REDACTED:CC>';
      }
      return m;
    });
    try {
      return JSON.parse(redacted);
    } catch {
      return redacted;
    }
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function generatePacketId(tenantId: string, planId: string, atMs: number): string {
  return createHash('sha256')
    .update(`${tenantId}:${planId}:${atMs}`)
    .digest('hex')
    .slice(0, 32);
}

function deriveSuggestions(
  executions: readonly ExecutionRecord[],
  verifications: readonly VerificationRecord[],
  rollbacks: readonly RollbackRecord[],
): string[] {
  const out: string[] = [];
  const failures = executions.filter((e) => e.outcome === 'failure').length;
  if (failures > 0) {
    out.push(`Review ${failures} failed action(s); consider re-classifying the action class.`);
  }
  const sev3 = verifications.filter((v) => v.driftSeverity === 3).length;
  if (sev3 > 0) {
    out.push(`${sev3} severity-3 drift(s) detected; verify the affected resources match expected state.`);
  }
  const failedRollbacks = rollbacks.filter((r) => r.resultState === 'failed').length;
  if (failedRollbacks > 0) {
    out.push(`${failedRollbacks} rollback(s) failed; manual remediation may be required.`);
  }
  if (out.length === 0) out.push('No follow-up actions required based on automated triage.');
  return out;
}
