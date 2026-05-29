/**
 * F.2.4 — PostgresRowCountVerifier.
 *
 * Post-execution verifier for `write.tenant_db.*` actions. Runs a SELECT
 * COUNT(*) against the tenant database and compares the result against
 * an expected count captured at execute time.
 *
 * Applies to: actionClass starts with `write.tenant_db.`.
 *
 * Verifier config:
 *
 *   {
 *     countSql:     string;             // SELECT COUNT(*)-shaped query
 *     params?:      readonly unknown[];
 *     expected:     number;             // captured at execute time
 *     tolerance?:   number;             // default 0 (exact match)
 *   }
 *
 * Severity assignment
 *   0  observed === expected
 *   1  abs(observed - expected) <= tolerance (within budget)
 *   2  abs(observed - expected) <= 2 * tolerance OR within 5% of expected
 *      (when expected > 0)
 *   3  larger drift OR DB error
 *
 * Tenant scoping: runs inside SET LOCAL app.tenant_id; same convention
 * as PostgresRollbackAdapter.
 *
 * The configured countSql is REJECTED by preflight if it begins with
 * anything other than `SELECT` (single-statement defence; we never run
 * UPDATE / INSERT / DELETE from a verifier).
 */
import type { Pool, PoolClient } from 'pg';
import type {
  DeferredVerifierInput,
  DriftSeverity,
  IPostExecutionVerifier,
  ImmediateVerifierInput,
  VerificationOutcome,
} from '@oweibo/core-contracts';

const UUID_RE = /^[0-9a-f-]{36}$/i;
const SELECT_PREFIX_RE = /^\s*select\b/i;

interface PostgresRowCountConfig {
  readonly countSql: string;
  readonly params?: readonly unknown[];
  readonly expected: number;
  readonly tolerance?: number;
}

export interface PostgresRowCountVerifierOptions {
  readonly deferredCheckAfterSeconds?: number;
}

export class PostgresRowCountVerifier implements IPostExecutionVerifier {
  readonly name = 'postgres_row_count';
  readonly deferredCheckAfterSeconds: number;

  constructor(
    private readonly pool: Pool,
    opts: PostgresRowCountVerifierOptions = {},
  ) {
    this.deferredCheckAfterSeconds = opts.deferredCheckAfterSeconds ?? 30;
  }

  appliesTo(actionClass: string): boolean {
    return actionClass.startsWith('write.tenant_db.');
  }

  async immediate(input: ImmediateVerifierInput): Promise<VerificationOutcome> {
    const cfg = readConfig((input.adapterOutcome as { verifierConfig?: unknown })?.verifierConfig);
    if (!cfg) return notConfigured();
    return this.runProbe(input.ctx.tenantId, cfg);
  }

  async deferred(input: DeferredVerifierInput): Promise<VerificationOutcome> {
    const cfg = readConfig(input.verifierConfig);
    if (!cfg) return notConfigured();
    return this.runProbe(input.tenantId, cfg);
  }

  private async runProbe(tenantId: string, cfg: PostgresRowCountConfig): Promise<VerificationOutcome> {
    if (!UUID_RE.test(tenantId)) {
      return outcome(3, cfg.expected, null, { notes: `invalid tenantId ${tenantId}` });
    }
    if (!SELECT_PREFIX_RE.test(cfg.countSql)) {
      return outcome(3, cfg.expected, null, { notes: 'countSql must begin with SELECT' });
    }
    let observed: number;
    try {
      observed = await withTenantClient(this.pool, tenantId, async (client) => {
        const r = await client.query<{ count: string }>(
          cfg.countSql,
          cfg.params ? Array.from(cfg.params) : undefined,
        );
        const raw = r.rows[0]?.count ?? '0';
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          throw new Error(`countSql first row.count is not numeric: ${String(raw)}`);
        }
        return n;
      });
    } catch (err) {
      return outcome(3, cfg.expected, null, { notes: describeError(err) });
    }
    const tolerance = cfg.tolerance ?? 0;
    const delta = Math.abs(observed - cfg.expected);
    if (delta === 0) return outcome(0, cfg.expected, observed);
    if (delta <= tolerance) return outcome(1, cfg.expected, observed, { notes: `within tolerance ±${tolerance}` });
    if (cfg.expected > 0) {
      const pctDrift = delta / cfg.expected;
      if (delta <= 2 * tolerance || pctDrift <= 0.05) {
        return outcome(2, cfg.expected, observed, { notes: `drift ${formatPct(pctDrift)}` });
      }
    } else if (delta <= 2 * tolerance) {
      return outcome(2, cfg.expected, observed, { notes: `delta ${delta}` });
    }
    return outcome(3, cfg.expected, observed, { notes: `drift exceeds 5% / 2× tolerance` });
  }
}

async function withTenantClient<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
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

function readConfig(raw: unknown): PostgresRowCountConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const cfg = raw as PostgresRowCountConfig;
  if (typeof cfg.countSql !== 'string' || cfg.countSql.length === 0) return null;
  if (typeof cfg.expected !== 'number' || !Number.isFinite(cfg.expected)) return null;
  return cfg;
}

function notConfigured(): VerificationOutcome {
  return outcome(2, 0, null, { notes: 'verifier config missing or malformed' });
}

function outcome(
  severity: DriftSeverity,
  expected: unknown,
  observed: unknown,
  extras: { notes?: string } = {},
): VerificationOutcome {
  return {
    severity,
    expected,
    observed,
    ...(extras.notes !== undefined ? { notes: extras.notes } : {}),
  };
}

function formatPct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
