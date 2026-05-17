// D.7 — ProductionSafetyChecker: closes audit gap E-07.
// Async post-processor on sampled 5% of agent output.
// D.8 — auto-rollback: advisory-locked channel revert on any violation hit.
//
// Never throws into the task path. ≤200ms latency budget enforced.

import type { Pool } from 'pg';

// ── OTEL counter (graceful no-op if @opentelemetry/api absent) ────────────────

interface OtelCounter { add(n: number, attrs?: Record<string, string>): void }

function tryGetCounter(name: string, description: string): OtelCounter {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const otel = require('@opentelemetry/api') as {
      metrics: { getMeter(n: string): { createCounter(n: string, o?: object): OtelCounter } };
    };
    return otel.metrics.getMeter('oweibo_safety').createCounter(name, { description });
  } catch {
    return { add: () => undefined };
  }
}

const safetyViolationCounter: OtelCounter = tryGetCounter(
  'prompt_safety_violation_total',
  'Production safety violations detected in sampled agent output (§14.3)',
);

// ── Types ─────────────────────────────────────────────────────────────────────

export type ViolationType = 'xss' | 'pii' | 'prompt_injection' | 'platform_identifier';

export interface SafetyContext {
  channel?:    string;
  promptHash?: string;
  role?:       string;
  taskId?:     string;
}

export interface SafetyViolation {
  type:    ViolationType;
  /** Redacted match — PII masked with *; others truncated to 80 chars. */
  matched: string;
  context: SafetyContext;
}

// ── Detection patterns ─────────────────────────────────────────────────────────

// XSS vectors
const XSS_PATTERNS: RegExp[] = [
  /<script[\s>/]/i,
  /javascript\s*:/i,
  /on(?:error|load|click|mouseover|focus|blur|submit|keydown|keyup|keypress|input|change)\s*=/i,
  /data:\s*text\/html/i,
  /vbscript\s*:/i,
  /<iframe[\s>]/i,
  /<object[\s>]/i,
];

// PII leakage
const PII_PATTERNS: RegExp[] = [
  /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/,  // email
  /\b\d{3}[- .]\d{2}[- .]\d{4}\b/,                           // SSN (US)
  /\b4\d{12}(?:\d{3})?\b|\b5[1-5]\d{14}\b|\b3[47]\d{13}\b/, // credit card
  /\b(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/, // US phone
];

// Prompt-injection artifacts
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+)?previous\s+instructions?/i,
  /disregard\s+(?:your\s+|all\s+)?instructions?/i,
  /you\s+are\s+now\s+(?:DAN|jailbroken|uncensored|free\s+from)/i,
  /forget\s+(?:your\s+)?(?:instructions?|constraints?|rules?|training)/i,
  /new\s+system\s+prompt\s*:/i,
  /override\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions?)/i,
  /\[SYSTEM\]\s*:/i,
  /<<<\s*(?:SYSTEM|INJECT|OVERRIDE|END\s*PROMPT)/i,
  /\bACT\s+AS\s+(?:an?\s+)?(?:unrestricted|evil|DAN)/i,
];

// Internal platform identifier leakage (schema names, internal topics, etc.)
const PLATFORM_IDENTIFIER_PATTERNS: RegExp[] = [
  /\boweibo\.(?:tasks|channels|bandit_arms|platform_lessons|prompt_versions|bandit_arm_events|cohort_promotion_rules)\b/i,
  /platform\.lesson\.submitted/,
  /task\.distillation\.failed/,
  /bandit_arm_events/i,
  /cohort_channel\s*[:=]/i,
  /assembled_hash\s*[:=]/i,
  /slot_pin_detail\s*[:=]/i,
  /oweibo-platform-patterns/,
  /gepa.optimizer/i,
];

function detectViolation(output: string): SafetyViolation | null {
  for (const re of XSS_PATTERNS) {
    const m = re.exec(output);
    if (m) return { type: 'xss', matched: m[0].slice(0, 80), context: {} };
  }
  for (const re of PII_PATTERNS) {
    const m = re.exec(output);
    if (m) {
      // Redact all but last 4 chars
      const redacted = m[0].replace(/.(?=.{4})/g, '*');
      return { type: 'pii', matched: redacted, context: {} };
    }
  }
  for (const re of INJECTION_PATTERNS) {
    const m = re.exec(output);
    if (m) return { type: 'prompt_injection', matched: m[0].slice(0, 80), context: {} };
  }
  for (const re of PLATFORM_IDENTIFIER_PATTERNS) {
    const m = re.exec(output);
    if (m) return { type: 'platform_identifier', matched: m[0].slice(0, 80), context: {} };
  }
  return null;
}

// ── ProductionSafetyChecker ────────────────────────────────────────────────────

export class ProductionSafetyChecker {
  constructor(
    /** Postgres pool for advisory-locked channel rollback (D.8). Omit to disable rollback. */
    private readonly pool?:        Pool,
    private readonly sampleRate =  0.05,
    /** Called synchronously after counter increment + rollback attempt, for alerting integrations. */
    private readonly onViolation?: (v: SafetyViolation) => void,
  ) {}

  /**
   * Fire-and-forget sampling gate.
   * Returns immediately; all work is async and isolated from the task path.
   * ≤200ms budget is enforced inside runCheck.
   */
  sampleAndCheck(output: string, ctx: SafetyContext): void {
    if (Math.random() >= this.sampleRate) return;
    void this.runCheck(output, ctx);
  }

  private async runCheck(output: string, ctx: SafetyContext): Promise<void> {
    const deadline = Date.now() + 200;
    try {
      const violation = detectViolation(output);
      if (!violation) return;

      violation.context = ctx;

      safetyViolationCounter.add(1, {
        channel:     ctx.channel    ?? 'unknown',
        prompt_hash: ctx.promptHash ?? 'unknown',
      });

      console.error(
        `[ProductionSafetyChecker] VIOLATION type=${violation.type} ` +
        `channel=${ctx.channel} hash=${ctx.promptHash} task=${ctx.taskId} ` +
        `matched="${violation.matched}"`,
      );

      // D.8: advisory-locked rollback before budget expires
      if (this.pool && ctx.channel && ctx.channel !== 'stable-v0' && Date.now() < deadline) {
        await this.rollbackChannel(ctx.channel, ctx.promptHash, ctx.role);
      }

      this.onViolation?.(violation);
    } catch (err) {
      // Safety checker must never surface errors to the task path
      console.warn('[ProductionSafetyChecker] runCheck error (suppressed):', String(err));
    }
  }

  /**
   * D.8 — Revert oweibo.channels rows for the given channel (and optionally role/hash)
   * back to stable-v0. Uses pg_advisory_xact_lock keyed on the channel name to prevent
   * concurrent rollback races between auto-promotion and manual rollback (§12 threat table).
   */
  private async rollbackChannel(
    channel:     string,
    promptHash?: string,
    role?:       string,
  ): Promise<void> {
    if (!this.pool) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Stable integer lock key from channel name (djb2 hash, safe for pg_advisory_xact_lock)
      const lockKey = [...channel].reduce(
        (acc: number, ch: string) => (Math.imul(acc, 31) + ch.charCodeAt(0)) | 0,
        5381,
      );
      await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

      const result = await client.query(
        `UPDATE oweibo.channels
         SET prompt_hash = (
           SELECT hash FROM oweibo.prompt_versions
           WHERE role          = oweibo.channels.role
             AND slot_id       = oweibo.channels.slot_id
             AND template_version = 'stable-v0'
           ORDER BY created_at ASC
           LIMIT 1
         ),
         version    = version + 1,
         updated_at = NOW(),
         updated_by = 'safety_auto_rollback'
         WHERE name = $1
           AND ($2::text IS NULL OR role = $2)
           AND ($3::text IS NULL OR prompt_hash = $3)`,
        [channel, role ?? null, promptHash ?? null],
      );

      await client.query('COMMIT');

      if ((result.rowCount ?? 0) > 0) {
        console.warn(
          `[ProductionSafetyChecker] Auto-rollback complete: channel=${channel} ` +
          `role=${role ?? 'all'} from_hash=${promptHash ?? 'any'} rows=${result.rowCount}`,
        );
      }
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
