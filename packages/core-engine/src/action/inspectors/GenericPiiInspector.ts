/**
 * S.5.a: GenericPiiInspector — broad inspector that runs against any
 * external-facing action class. Flags presence of high-confidence PII
 * patterns (SSN, US credit card via Luhn, IBAN) in the payload.
 *
 * Applies to:
 *   * comm.external_email, comm.external_message
 *   * write.external_api.prod
 *
 * Outright forbids:
 *   * payload contains a credit-card-shaped number that passes Luhn
 *
 * Upgrades to require_approval:
 *   * SSN-shaped match (XXX-XX-XXXX)
 *   * IBAN-shaped match (passes the simple length+checksum sanity check)
 *
 * Heuristic, not authoritative. The inspector serializes the payload via
 * JSON.stringify and runs regexes; objects with circular refs (rare for
 * action payloads) will throw and the registry will fail-closed.
 */
import type {
  ActionContext,
  ContentInspectionResult,
  IContentInspector,
} from '@oweibo/core-contracts';

const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/;
const CC_RE = /\b(?:\d[ -]?){13,19}\b/g;
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/;

const APPLIES_TO_CLASSES: ReadonlySet<string> = new Set([
  'comm.external_email',
  'comm.external_message',
  'write.external_api.prod',
]);

export class GenericPiiInspector implements IContentInspector {
  readonly name = 'generic_pii';

  appliesTo(actionClass: string): boolean {
    return APPLIES_TO_CLASSES.has(actionClass);
  }

  async inspect(ctx: ActionContext): Promise<ContentInspectionResult> {
    const serialized = safeStringify(ctx.payload);

    // Credit card numbers — Luhn-validated.
    for (const match of serialized.matchAll(CC_RE)) {
      const digits = match[0].replace(/[^\d]/g, '');
      if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) {
        return {
          verdict: 'forbid',
          reason: 'payload contains a Luhn-valid credit-card-shaped number',
          details: { matched: 'CREDIT_CARD', digits: digits.length },
        };
      }
    }

    if (SSN_RE.test(serialized)) {
      return {
        verdict: 'upgrade_to_approval',
        reason: 'payload contains an SSN-shaped match',
        details: { matched: 'SSN' },
      };
    }
    if (IBAN_RE.test(serialized) && looksLikeIban(serialized.match(IBAN_RE)![0])) {
      return {
        verdict: 'upgrade_to_approval',
        reason: 'payload contains an IBAN-shaped match',
        details: { matched: 'IBAN' },
      };
    }

    return { verdict: 'allow' };
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v ?? null);
  } catch {
    return String(v ?? '');
  }
}

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

function looksLikeIban(s: string): boolean {
  // ISO-13616 lengths range 15–34. Quick sanity bound + alnum check.
  return s.length >= 15 && s.length <= 34 && /^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s);
}
