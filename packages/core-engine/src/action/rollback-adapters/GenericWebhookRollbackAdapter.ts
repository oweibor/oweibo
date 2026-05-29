/**
 * S.3: GenericWebhookRollbackAdapter — POSTs an HMAC-signed JSON payload
 * to a tenant-configured webhook URL.
 *
 * Used for custom integrations where the rollback is a compensating
 * call to a tenant-owned system (PagerDuty resolution, internal
 * escalation workflow tools, custom undo endpoints). The adapter
 * itself only knows how to send a signed POST and interpret the
 * response — what to send is encoded in the rollback envelope's
 * `details` and `rollbackPlan` fields.
 *
 * The receiver MUST:
 *   - Verify the X-Oweibo-Signature header before processing.
 *   - Return HTTP 200/2xx on success.
 *   - Return HTTP 4xx for permanent failures (orchestrator marks
 *     `failed`, no retry).
 *   - Return HTTP 5xx for transient failures (orchestrator may retry).
 *
 * Response body shape (optional but recommended):
 *   { "state": "fully_reverted" | "partial" | "failed",
 *     "details": string,
 *     "sideEffects": string[],
 *     "costUsdCents": number }
 *
 * Defaults are applied for missing fields so a bare 200 is interpreted
 * as { state: 'fully_reverted', details: 'ok', sideEffects: [], costUsdCents: 0 }.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import type {
  IRollbackAdapter,
  RollbackContext,
  RollbackEnvelope,
  RollbackResult,
} from '@oweibo/core-contracts';

export interface WebhookConfig {
  readonly url: string;
  readonly hmacSecret: string;
}

export interface WebhookConfigResolver {
  /** Returns the tenant's configured webhook destination, or null if none. */
  resolve(tenantId: string): Promise<WebhookConfig | null>;
}

export interface GenericWebhookRollbackAdapterOptions {
  /** Override for testing. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Request timeout (ms). Default 30 000. */
  timeoutMs?: number;
  /** Override clock; tests pin time. */
  now?: () => Date;
}

interface WebhookResponseBody {
  readonly state?: 'fully_reverted' | 'partial' | 'failed';
  readonly details?: string;
  readonly sideEffects?: readonly string[];
  readonly costUsdCents?: number;
}

export class GenericWebhookRollbackAdapter implements IRollbackAdapter {
  readonly name = 'webhook';
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly resolver?: WebhookConfigResolver,
    opts: GenericWebhookRollbackAdapterOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? ((typeof fetch !== 'undefined' ? fetch : undefined) as typeof fetch);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.now = opts.now ?? (() => new Date());
  }

  async preflight(envelope: RollbackEnvelope, ctx: RollbackContext): Promise<void> {
    if (!this.resolver) {
      throw new Error('webhook adapter has no config resolver wired');
    }
    if (!this.fetchImpl) {
      throw new Error('webhook adapter has no fetch implementation (Node < 18?)');
    }
    const cfg = await this.resolver.resolve(ctx.tenantId);
    if (!cfg) {
      throw new Error(`no webhook URL configured for tenant ${ctx.tenantId}`);
    }
    if (!cfg.hmacSecret) {
      throw new Error(`webhook config for tenant ${ctx.tenantId} has empty hmacSecret`);
    }
    // Quick URL sanity check — refuse non-http(s) URLs to prevent the
    // adapter being used as an SSRF vector. Tenants supplying file://
    // or gopher:// URLs is a config bug, not a feature.
    let url: URL;
    try {
      url = new URL(cfg.url);
    } catch {
      throw new Error(`webhook URL is not a valid URL: ${cfg.url}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`webhook URL must use http(s); got ${url.protocol}`);
    }
    void envelope;
  }

  async execute(envelope: RollbackEnvelope, ctx: RollbackContext): Promise<RollbackResult> {
    // preflight already validated resolver + fetch + url, but re-check
    // since callers can in principle skip preflight.
    if (!this.resolver) return failed('webhook adapter has no config resolver wired');
    const cfg = await this.resolver.resolve(ctx.tenantId);
    if (!cfg) return failed(`no webhook URL configured for tenant ${ctx.tenantId}`);

    const body = JSON.stringify({
      protocolVersion: 1,
      issuedAt: this.now().toISOString(),
      tenantId: ctx.tenantId,
      originalActionId: ctx.originalActionId,
      originalPlanId: ctx.originalPlanId,
      correlationId: ctx.correlationId,
      invokedBy: ctx.invokedBy,
      envelope: {
        kind: envelope.kind,
        details: envelope.details,
        rollbackPlan: envelope.rollbackPlan ?? null,
      },
    });
    const signature = signHmac(body, cfg.hmacSecret);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(cfg.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-oweibo-signature': `sha256=${signature}`,
          'x-oweibo-correlation-id': ctx.correlationId,
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      return failed(`webhook POST failed: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    let parsed: WebhookResponseBody = {};
    try {
      const text = await response.text();
      if (text) parsed = JSON.parse(text) as WebhookResponseBody;
    } catch {
      // Empty body or non-JSON body — fall through to defaults.
    }

    if (!response.ok) {
      // 4xx ⇒ permanent failure; 5xx ⇒ also failed for now (the
      // orchestrator handles retry logic at its level).
      return {
        success: false,
        state: 'failed',
        details: parsed.details
          ?? `webhook returned HTTP ${response.status} ${response.statusText}`,
        sideEffects: parsed.sideEffects ?? [],
        costUsdCents: parsed.costUsdCents ?? 0,
      };
    }

    const state = parsed.state ?? 'fully_reverted';
    const success = state !== 'failed';
    return {
      success,
      state,
      details: parsed.details ?? (success ? 'webhook reported success' : 'webhook reported failure'),
      sideEffects: parsed.sideEffects ?? [],
      costUsdCents: parsed.costUsdCents ?? 0,
    };
  }
}

/**
 * Verify an incoming X-Oweibo-Signature header against the canonical
 * body. Exported for receivers (or tests) to use the same HMAC scheme
 * the adapter signs with. Use `timingSafeEqual` to avoid timing leaks.
 */
export function verifyWebhookSignature(
  body: string,
  headerValue: string,
  hmacSecret: string,
): boolean {
  const prefix = 'sha256=';
  if (!headerValue.startsWith(prefix)) return false;
  const provided = headerValue.slice(prefix.length);
  const expected = signHmac(body, hmacSecret);
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function signHmac(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function failed(details: string): RollbackResult {
  return { success: false, state: 'failed', details, sideEffects: [], costUsdCents: 0 };
}
