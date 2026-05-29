/**
 * F.2.4 — EmailDeliveredVerifier.
 *
 * Post-execution verifier for `comm.external_email` actions. Polls a
 * delivery-receipt endpoint (SMTP relay, transactional email provider)
 * to verify the email actually reached the recipient.
 *
 * Applies to: actionClass === 'comm.external_email'.
 *
 * Verifier config:
 *
 *   {
 *     receiptUrl:       string;            // e.g. https://relay/v1/messages/{messageId}
 *     messageId:        string;            // adapter-returned message id
 *     authHeaderName?:  string;            // default 'Authorization'
 *     authHeaderValue?: string;            // bearer or basic creds (passed through)
 *     timeoutMs?:       number;            // default 10_000
 *   }
 *
 * Severity assignment
 *   0  response state ∈ {delivered}
 *   1  state ∈ {queued, sent, accepted} — not yet final; deferred re-run will catch up
 *   2  state ∈ {deferred, throttled} — transport-side congestion; surface to operator
 *   3  state ∈ {bounced, failed, rejected, spam} OR receipt 404/410 — definitive failure
 *
 * The deferred timing is intentionally large (default 300s = 5 min) because
 * most providers backfill the delivered receipt asynchronously.
 */
import type {
  DeferredVerifierInput,
  DriftSeverity,
  IPostExecutionVerifier,
  ImmediateVerifierInput,
  VerificationOutcome,
} from '@oweibo/core-contracts';

interface EmailDeliveredConfig {
  readonly receiptUrl: string;
  readonly messageId: string;
  readonly authHeaderName?: string;
  readonly authHeaderValue?: string;
  readonly timeoutMs?: number;
}

interface ReceiptBody {
  readonly state?: string;
  readonly deliveredAt?: string;
  readonly reason?: string;
}

const DELIVERED_STATES = new Set(['delivered']);
const TRANSIENT_QUEUE  = new Set(['queued', 'sent', 'accepted']);
const TRANSIENT_TROUBLE = new Set(['deferred', 'throttled']);
const TERMINAL_FAIL    = new Set(['bounced', 'failed', 'rejected', 'spam']);

export interface EmailDeliveredVerifierOptions {
  readonly fetchImpl?: typeof fetch;
  readonly deferredCheckAfterSeconds?: number;
  readonly timeoutMs?: number;
}

export class EmailDeliveredVerifier implements IPostExecutionVerifier {
  readonly name = 'email_delivered';
  readonly deferredCheckAfterSeconds: number;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;

  constructor(opts: EmailDeliveredVerifierOptions = {}) {
    this.fetchImpl = opts.fetchImpl
      ?? ((typeof fetch !== 'undefined' ? fetch : undefined) as typeof fetch);
    this.deferredCheckAfterSeconds = opts.deferredCheckAfterSeconds ?? 300;
    this.defaultTimeoutMs = opts.timeoutMs ?? 10_000;
  }

  appliesTo(actionClass: string): boolean {
    return actionClass === 'comm.external_email';
  }

  async immediate(input: ImmediateVerifierInput): Promise<VerificationOutcome> {
    const cfg = readConfig((input.adapterOutcome as { verifierConfig?: unknown })?.verifierConfig);
    if (!cfg) return notConfigured();
    return this.runProbe(cfg);
  }

  async deferred(input: DeferredVerifierInput): Promise<VerificationOutcome> {
    const cfg = readConfig(input.verifierConfig);
    if (!cfg) return notConfigured();
    return this.runProbe(cfg);
  }

  private async runProbe(cfg: EmailDeliveredConfig): Promise<VerificationOutcome> {
    if (!this.fetchImpl) {
      return outcome(3, 'delivered', 'no-fetch', { notes: 'no fetch implementation' });
    }
    const timeoutMs = cfg.timeoutMs ?? this.defaultTimeoutMs;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref?.();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (cfg.authHeaderValue) {
      const name = cfg.authHeaderName ?? 'Authorization';
      headers[name] = cfg.authHeaderValue;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(cfg.receiptUrl, { method: 'GET', headers, signal: ac.signal });
    } catch (err) {
      clearTimeout(timer);
      return outcome(3, 'delivered', 'unreachable', { notes: describeError(err) });
    }
    clearTimeout(timer);

    if (res.status === 404 || res.status === 410) {
      return outcome(3, 'delivered', `HTTP ${res.status}`, { notes: 'receipt not found' });
    }
    if (res.status < 200 || res.status >= 300) {
      return outcome(2, 'delivered', `HTTP ${res.status}`, { notes: 'receipt fetch failed' });
    }
    let body: ReceiptBody;
    try {
      body = await res.json() as ReceiptBody;
    } catch (err) {
      return outcome(2, 'delivered', null, { notes: `receipt body not JSON: ${describeError(err)}` });
    }
    const state = (body.state ?? '').toLowerCase();
    if (DELIVERED_STATES.has(state)) {
      return outcome(0, 'delivered', body);
    }
    if (TRANSIENT_QUEUE.has(state)) {
      return outcome(1, 'delivered', body, { notes: 'transient queue state' });
    }
    if (TRANSIENT_TROUBLE.has(state)) {
      return outcome(2, 'delivered', body, { notes: `transport state ${state}` });
    }
    if (TERMINAL_FAIL.has(state)) {
      return outcome(3, 'delivered', body, { notes: body.reason ?? `terminal state ${state}` });
    }
    return outcome(2, 'delivered', body, { notes: `unknown state ${state}` });
  }
}

function readConfig(raw: unknown): EmailDeliveredConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const cfg = raw as EmailDeliveredConfig;
  if (typeof cfg.receiptUrl !== 'string' || cfg.receiptUrl.length === 0) return null;
  if (typeof cfg.messageId !== 'string' || cfg.messageId.length === 0) return null;
  return cfg;
}

function notConfigured(): VerificationOutcome {
  return outcome(2, 'delivered', null, { notes: 'verifier config missing or malformed' });
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

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
