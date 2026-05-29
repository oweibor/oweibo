/**
 * F.2.2 — DeployRollbackAdapter.
 *
 * Rolls back `deploy.*` actions by POSTing to the platform's deploy
 * service `/rollback/<deploymentId>` endpoint. The deploy service config
 * (base URL, optional HMAC secret) is resolved per tenant through an
 * injectable resolver so this adapter doesn't reach into a Pg row directly.
 *
 * RollbackEnvelope.rollbackPlan shape:
 *
 *   {
 *     deploymentId:   string;
 *     environment?:   string;     // optional context the deploy service may need
 *     reason?:        string;     // operator-supplied note
 *   }
 *
 * Preflight refuses when:
 *   - envelope.kind === 'irreversible'
 *   - rollbackPlan missing or deploymentId malformed
 *   - resolver has no config for the tenant
 *
 * Execute behaviour:
 *   - POST { deploymentId, environment, reason, correlationId } to
 *     <baseUrl>/rollback/<deploymentId>
 *   - HMAC the body with X-Oweibo-Signature when hmacSecret is set.
 *   - 2xx → fully_reverted (with returned `state` overriding when supplied).
 *   - non-2xx → failed.
 *   - never throws.
 *
 * The deploy service is expected to be idempotent on (deploymentId).
 * Concurrent rollbacks of the same deployment are prevented upstream by
 * the orchestrator's UNIQUE constraint on rollback_executions.
 */
import { createHmac } from 'crypto';
import type {
  IRollbackAdapter,
  RollbackContext,
  RollbackEnvelope,
  RollbackResult,
} from '@oweibo/core-contracts';

interface DeployRollbackPlan {
  readonly deploymentId: string;
  readonly environment?: string;
  readonly reason?: string;
}

export interface DeployConfig {
  readonly baseUrl: string;
  /** Plaintext HMAC secret, or null when no signature is required. */
  readonly hmacSecret: string | null;
}

export interface DeployConfigResolver {
  resolve(tenantId: string): Promise<DeployConfig | null>;
}

export interface DeployRollbackAdapterOptions {
  /** Override for testing. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Request timeout (ms). Default 30 000. */
  readonly timeoutMs?: number;
}

interface DeployRollbackResponse {
  readonly state?: 'fully_reverted' | 'partial' | 'failed';
  readonly details?: string;
  readonly sideEffects?: readonly string[];
  readonly costUsdCents?: number;
}

const DEPLOYMENT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export class DeployRollbackAdapter implements IRollbackAdapter {
  readonly name = 'deploy';
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly resolver: DeployConfigResolver,
    opts: DeployRollbackAdapterOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl
      ?? ((typeof fetch !== 'undefined' ? fetch : undefined) as typeof fetch);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async preflight(envelope: RollbackEnvelope, ctx: RollbackContext): Promise<void> {
    if (envelope.kind === 'irreversible') {
      throw new Error('deploy rollback: envelope.kind=irreversible');
    }
    const plan = envelope.rollbackPlan as DeployRollbackPlan | undefined;
    if (!plan || typeof plan !== 'object') {
      throw new Error('deploy rollback: missing rollbackPlan');
    }
    if (typeof plan.deploymentId !== 'string' || !DEPLOYMENT_ID_RE.test(plan.deploymentId)) {
      throw new Error(`deploy rollback: rollbackPlan.deploymentId missing or malformed`);
    }
    const cfg = await this.resolver.resolve(ctx.tenantId);
    if (!cfg) {
      throw new Error('deploy rollback: no deploy config for tenant');
    }
    let url: URL;
    try {
      url = new URL(cfg.baseUrl);
    } catch {
      // node's URL parser throws on malformed input; surface the operator-
      // readable reason instead of the raw "Invalid URL" message.
      throw new Error(`deploy rollback: malformed baseUrl ${cfg.baseUrl}`);
    }
    if (url.protocol !== 'https:' && !isLoopback(url.hostname)) {
      throw new Error(`deploy rollback: insecure baseUrl ${cfg.baseUrl}`);
    }
  }

  async execute(envelope: RollbackEnvelope, ctx: RollbackContext): Promise<RollbackResult> {
    if (!this.fetchImpl) {
      return failed('deploy rollback: no fetch implementation (Node < 18?)');
    }
    const plan = envelope.rollbackPlan as DeployRollbackPlan;
    let cfg: DeployConfig | null;
    try {
      cfg = await this.resolver.resolve(ctx.tenantId);
    } catch (err) {
      return failed(`deploy rollback: resolver failed: ${describeError(err)}`);
    }
    if (!cfg) return failed('deploy rollback: no deploy config');

    const body = JSON.stringify({
      deploymentId:   plan.deploymentId,
      environment:    plan.environment,
      reason:         plan.reason,
      correlationId:  ctx.correlationId,
    });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
    };
    if (cfg.hmacSecret) {
      const sig = createHmac('sha256', cfg.hmacSecret).update(body).digest('hex');
      headers['X-Oweibo-Signature'] = `v1=${sig}`;
    }

    const url = `${cfg.baseUrl.replace(/\/$/, '')}/rollback/${encodeURIComponent(plan.deploymentId)}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    timer.unref?.();
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: 'POST', headers, body, signal: ac.signal });
    } catch (err) {
      clearTimeout(timer);
      return failed(`deploy rollback: fetch failed: ${describeError(err)}`);
    }
    clearTimeout(timer);

    if (res.status < 200 || res.status >= 300) {
      return failed(`deploy rollback: HTTP ${res.status}`);
    }
    let parsed: DeployRollbackResponse = {};
    try {
      parsed = await res.json() as DeployRollbackResponse;
    } catch {
      // Empty / non-JSON 2xx counts as success with no details.
    }
    return {
      success: parsed.state !== 'failed',
      state:   parsed.state ?? 'fully_reverted',
      details: parsed.details ?? `deploy rollback ${plan.deploymentId} succeeded`,
      sideEffects: parsed.sideEffects ?? [`deploy.rollback_started=${plan.deploymentId}`],
      costUsdCents: parsed.costUsdCents ?? 0,
    };
  }
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failed(details: string): RollbackResult {
  return { success: false, state: 'failed', details, sideEffects: [], costUsdCents: 0 };
}
