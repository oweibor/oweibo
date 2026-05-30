/**
 * F.5.10 (ttv-finals): PgDomainIntakeProcessor adapter.
 *
 * Implements the DomainIntakeStep's IDomainIntakeProcessor: loads the
 * intake row, drives the (optional) sandboxed repo scan, calls
 * DomainIntakeService.classifyAndRecommend, persists results back to
 * oweibo.tenant_domain_intake, and transitions intake_state through
 * processing -> complete / failed.
 *
 * Security: when the intake row carries a repo URL in repo_scan_summary,
 * the URL is passed to an IRepoSandbox impl — never to in-process code.
 * The sandbox enforces the F.5.10a contract (separate container, seccomp,
 * 120s wall clock, size/file caps, no execution). See RepoScanSandbox.ts.
 *
 * Idempotency: state transitions form a state machine — calling process()
 * twice while the second is mid-flight is guarded by the
 * pending/processing CAS in start(). Re-run on a 'complete' row is a
 * no-op (state transition fails the CAS).
 *
 * F.5.10b (security review) — NOT done in this commit. The threat model
 * doc + manual escape tests + external reviewer signoff per plan
 * §F.5.10b remain a separate follow-up; this adapter ships behind
 * DOMAIN_INTAKE_ENABLED=false until that review lands.
 */
import type { Pool, PoolClient } from 'pg';
import type { DomainIntakeService, IntakeInput } from '../DomainIntakeService.js';
import type { IRepoSandbox, RepoSignals } from './RepoScanSandbox.js';
import { RepoScanError } from './RepoScanSandbox.js';

export type IntakeStateLookup = 'pending' | 'requested' | 'processing' | 'complete' | 'skipped' | 'failed';

export interface IntakeProcessResult {
  readonly classifiedDomain: string | null;
  readonly classifiedConfidence: number | null;
  readonly recommendedTemplate: string | null;
  readonly recommendedConnectors: readonly string[];
  readonly recommendedSeedSkills: readonly string[];
}

interface IntakeRow {
  intake_state:            IntakeStateLookup;
  interview_answers:       Record<string, unknown> | null;
  repo_scan_summary:       Record<string, unknown> | null;
  primer_doc_count:        number;
}

export interface PgDomainIntakeProcessorOptions {
  /** Optional override: limit primer_excerpts to N items (default: all). */
  readonly maxPrimerExcerpts?: number;
}

export class PgDomainIntakeProcessor {
  constructor(
    private readonly pool: Pool,
    private readonly intake: DomainIntakeService,
    private readonly sandbox: IRepoSandbox,
    private readonly opts: PgDomainIntakeProcessorOptions = {},
  ) {}

  async loadState(tenantId: string): Promise<IntakeStateLookup | 'absent'> {
    const r = await this.pool.query<{ intake_state: IntakeStateLookup }>(
      `SELECT intake_state FROM oweibo.tenant_domain_intake WHERE tenant_id = $1::uuid`,
      [tenantId],
    );
    return r.rows[0]?.intake_state ?? 'absent';
  }

  async process(tenantId: string): Promise<IntakeProcessResult> {
    const claimed = await this.claimRow(tenantId);
    if (!claimed) {
      throw new Error('intake_not_requested');
    }

    let signals: RepoSignals | null = null;
    try {
      const repoUrl = typeof claimed.repo_scan_summary?.['repoUrl'] === 'string'
        ? claimed.repo_scan_summary['repoUrl'] as string
        : null;
      if (repoUrl) {
        signals = await this.scanRepo(repoUrl);
      }

      const input = this.buildIntakeInput(claimed, signals);
      const recommendation = await this.intake.classifyAndRecommend(input);

      const result: IntakeProcessResult = {
        classifiedDomain: recommendation.classification.domain === 'unclassified'
          ? null
          : recommendation.classification.domain,
        classifiedConfidence: recommendation.classification.confidence,
        recommendedTemplate: recommendation.classification.recommendedTemplate ?? null,
        recommendedConnectors: recommendation.classification.recommendedConnectors ?? [],
        recommendedSeedSkills: recommendation.recommendedSeedSkills,
      };

      await this.completeRow(tenantId, result, signals);
      return result;
    } catch (err) {
      await this.failRow(tenantId, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  // ── Sandbox bridge ──────────────────────────────────────────────────────

  private async scanRepo(repoUrl: string): Promise<RepoSignals | null> {
    try {
      return await this.sandbox.scan({ repoUrl });
    } catch (err) {
      // Sandbox errors are NOT fatal to intake — fall through to
      // interview-answers-only classification. The error reason is
      // recorded as a note for operators.
      if (err instanceof RepoScanError) {
        return {
          languages: [],
          frameworks: [],
          fileCount: 0,
          truncated: false,
          notes: [`repo_scan_failed: ${err.reason}`],
        };
      }
      throw err;
    }
  }

  private buildIntakeInput(row: IntakeRow, signals: RepoSignals | null): IntakeInput {
    const interview = parseInterviewAnswers(row.interview_answers);
    const primerExcerpts = parsePrimerExcerpts(row.repo_scan_summary, this.opts.maxPrimerExcerpts);
    const result: { -readonly [K in keyof IntakeInput]?: IntakeInput[K] } = {};
    if (interview.length > 0) result.interviewAnswers = interview;
    if (primerExcerpts.length > 0) result.primerExcerpts = primerExcerpts;
    if (signals) {
      const repoSignals: { -readonly [K in keyof NonNullable<IntakeInput['repoSignals']>]?: NonNullable<IntakeInput['repoSignals']>[K] } = {};
      if (signals.languages.length > 0) repoSignals.languages = signals.languages;
      if (signals.frameworks.length > 0) repoSignals.frameworks = signals.frameworks;
      if (signals.notes.length > 0) repoSignals.notes = signals.notes;
      result.repoSignals = repoSignals;
    }
    return result;
  }

  // ── State transitions ──────────────────────────────────────────────────

  private async claimRow(tenantId: string): Promise<IntakeRow | null> {
    return this.tx(tenantId, async (client) => {
      const r = await client.query<IntakeRow>(
        `UPDATE oweibo.tenant_domain_intake
            SET intake_state = 'processing',
                started_at   = COALESCE(started_at, NOW()),
                updated_at   = NOW()
          WHERE tenant_id = $1::uuid
            AND intake_state = 'requested'
          RETURNING intake_state, interview_answers, repo_scan_summary, primer_doc_count`,
        [tenantId],
      );
      return r.rows[0] ?? null;
    });
  }

  private async completeRow(tenantId: string, result: IntakeProcessResult, signals: RepoSignals | null): Promise<void> {
    await this.tx(tenantId, async (client) => {
      await client.query(
        `UPDATE oweibo.tenant_domain_intake
            SET intake_state               = 'complete',
                classified_domain          = $2,
                classified_confidence      = $3,
                recommended_template_slug  = $4,
                recommended_connectors     = $5::text[],
                recommended_seed_skills    = $6::text[],
                repo_scan_summary          = COALESCE(repo_scan_summary, '{}'::jsonb) || $7::jsonb,
                completed_at               = NOW(),
                updated_at                 = NOW()
          WHERE tenant_id = $1::uuid`,
        [
          tenantId,
          result.classifiedDomain,
          result.classifiedConfidence,
          result.recommendedTemplate,
          result.recommendedConnectors,
          result.recommendedSeedSkills,
          JSON.stringify({ signals: signals ?? null }),
        ],
      );
    });
  }

  private async failRow(tenantId: string, error: string): Promise<void> {
    await this.tx(tenantId, async (client) => {
      await client.query(
        `UPDATE oweibo.tenant_domain_intake
            SET intake_state = 'failed',
                repo_scan_summary = COALESCE(repo_scan_summary, '{}'::jsonb) ||
                                    jsonb_build_object('lastError', $2::text),
                updated_at = NOW()
          WHERE tenant_id = $1::uuid`,
        [tenantId, error],
      );
    });
  }

  private async tx<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (/^[0-9a-f-]{36}$/i.test(tenantId)) {
        await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
      }
      await client.query(`SET LOCAL ROLE platform_admin`).catch(() => undefined);
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
}

// ── Pure helpers ────────────────────────────────────────────────────────

function parseInterviewAnswers(raw: Record<string, unknown> | null): readonly { question: string; answer: string }[] {
  if (!raw || typeof raw !== 'object') return [];
  // Support two shapes: an array under .pairs OR a top-level object map.
  const pairs = (raw as Record<string, unknown>)['pairs'];
  if (Array.isArray(pairs)) {
    return pairs
      .filter((p): p is { question: string; answer: string } =>
        typeof p === 'object' && p !== null
        && typeof (p as Record<string, unknown>)['question'] === 'string'
        && typeof (p as Record<string, unknown>)['answer'] === 'string')
      .map((p) => ({ question: p.question, answer: p.answer }));
  }
  return Object.entries(raw)
    .filter(([_, v]) => typeof v === 'string')
    .map(([k, v]) => ({ question: k, answer: v as string }));
}

function parsePrimerExcerpts(raw: Record<string, unknown> | null, max?: number): readonly string[] {
  if (!raw) return [];
  const excerpts = (raw as Record<string, unknown>)['primerExcerpts'];
  if (!Array.isArray(excerpts)) return [];
  const filtered = excerpts.filter((s): s is string => typeof s === 'string');
  return max ? filtered.slice(0, max) : filtered;
}
