/**
 * F.1.2 — HmacPacketSigner.
 *
 * Implements IPacketSigner from core-contracts using HMAC-SHA256.
 *
 * Signature format
 * ────────────────
 *   `v1:<hex-encoded HMAC-SHA256(key, bytes)>`
 *
 * The `v1:` prefix reserves room for a v2 algorithm migration without
 * breaking ref parsing. Verify rejects any signature whose prefix doesn't
 * match the current parser.
 *
 * Key rotation
 * ────────────
 * The signer accepts a primary key and an optional `next` key.
 *   - sign() always uses primary.
 *   - verify() tries primary first, then next (when set).
 *
 * Operator transition flow:
 *   t0: primary=K1                  — signing + verifying with K1
 *   t1: primary=K1, next=K2         — deploy; verify accepts both
 *   t2: primary=K2, next=K1         — promote K2; old packets still verify
 *   t3: primary=K2                  — drop K1 once all old packets retired
 *
 * Replay defence
 * ──────────────
 * HMAC alone does not prevent signature reuse. Callers MUST include a nonce
 * or timestamp inside `bytes` (the builder already includes `builtAtMs`).
 *
 * Secret resolution
 * ─────────────────
 * `fromInfraCredentials` reads `infra/forensic-signer` via SecretsManager
 * expecting `{ FORENSIC_SIGNING_KEY: <base64>, FORENSIC_SIGNING_KEY_NEXT?: <base64> }`.
 * Missing primary throws — there is no insecure fallback path.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import type { IPacketSigner } from '@oweibo/core-contracts';
import type { SecretsManager } from '../../secrets/SecretsManager.js';

const VERSION_PREFIX = 'v1:';
/** HMAC-SHA256 produces 32 raw bytes → 64 hex chars. */
const HEX_LEN = 64;
const HEX_RE = /^[0-9a-f]+$/i;

export interface HmacPacketSignerOptions {
  /** Primary signing key (raw bytes). 32 bytes (256-bit) recommended. */
  readonly primary: Buffer;
  /** Optional rotation key. verify() accepts signatures from either. */
  readonly next?: Buffer;
}

export class HmacPacketSigner implements IPacketSigner {
  private readonly primary: Buffer;
  private readonly next: Buffer | null;

  constructor(opts: HmacPacketSignerOptions) {
    if (!opts.primary || opts.primary.length === 0) {
      throw new Error('HmacPacketSigner: primary key required');
    }
    if (opts.primary.length < 16) {
      // Anything shorter than 128 bits is meaningfully weak for HMAC-SHA256.
      throw new Error(
        `HmacPacketSigner: primary key too short (${opts.primary.length} bytes; need >= 16)`,
      );
    }
    this.primary = opts.primary;
    this.next = opts.next && opts.next.length > 0 ? opts.next : null;
    if (this.next && this.next.length < 16) {
      throw new Error(
        `HmacPacketSigner: next key too short (${this.next.length} bytes; need >= 16)`,
      );
    }
  }

  async sign(bytes: Buffer): Promise<string> {
    const hex = hmacHex(this.primary, bytes);
    return `${VERSION_PREFIX}${hex}`;
  }

  async verify(bytes: Buffer, signature: string): Promise<boolean> {
    if (!signature.startsWith(VERSION_PREFIX)) return false;
    const hex = signature.slice(VERSION_PREFIX.length);
    if (hex.length !== HEX_LEN || !HEX_RE.test(hex)) return false;
    const supplied = Buffer.from(hex, 'hex');
    if (supplied.length !== 32) return false;

    const expectedPrimary = Buffer.from(hmacHex(this.primary, bytes), 'hex');
    if (constantTimeEq(supplied, expectedPrimary)) return true;
    if (this.next) {
      const expectedNext = Buffer.from(hmacHex(this.next, bytes), 'hex');
      if (constantTimeEq(supplied, expectedNext)) return true;
    }
    return false;
  }
}

function hmacHex(key: Buffer, bytes: Buffer): string {
  return createHmac('sha256', key).update(bytes).digest('hex');
}

/**
 * timingSafeEqual throws on length mismatch; both args are 32-byte HMAC
 * outputs in our control, but wrap the comparison anyway so a future
 * length-mismatch is a `false` rather than a thrown exception that would
 * leak timing information via the catch path.
 */
function constantTimeEq(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Composition helper ──────────────────────────────────────────────────

interface ForensicSignerSecrets {
  readonly FORENSIC_SIGNING_KEY?: unknown;
  readonly FORENSIC_SIGNING_KEY_NEXT?: unknown;
}

/**
 * Construct an HmacPacketSigner from `infra/forensic-signer` via the
 * SecretsManager. Expected payload shape:
 *
 *   {
 *     "FORENSIC_SIGNING_KEY":      "<base64-encoded primary key>",
 *     "FORENSIC_SIGNING_KEY_NEXT": "<base64-encoded rotation key>"  // optional
 *   }
 *
 * Throws when the primary key is missing or invalid — no insecure fallback.
 * Callers wiring forensic features should treat a thrown error as a fatal
 * misconfiguration at startup.
 */
export async function hmacPacketSignerFromSecrets(
  secrets: SecretsManager,
): Promise<HmacPacketSigner> {
  const raw = (await secrets.getInfraCredentials('forensic-signer')) as ForensicSignerSecrets | null;
  if (!raw) {
    throw new Error(
      "hmacPacketSignerFromSecrets: infra/forensic-signer not found in Vault. " +
      "Store { FORENSIC_SIGNING_KEY: '<base64>' } before enabling forensic features.",
    );
  }
  const primary = decodeBase64Key(raw.FORENSIC_SIGNING_KEY, 'FORENSIC_SIGNING_KEY');
  const next = raw.FORENSIC_SIGNING_KEY_NEXT !== undefined && raw.FORENSIC_SIGNING_KEY_NEXT !== null
    ? decodeBase64Key(raw.FORENSIC_SIGNING_KEY_NEXT, 'FORENSIC_SIGNING_KEY_NEXT')
    : undefined;
  return new HmacPacketSigner({ primary, ...(next !== undefined ? { next } : {}) });
}

function decodeBase64Key(value: unknown, name: string): Buffer {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`hmacPacketSignerFromSecrets: ${name} missing or not a string`);
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(value, 'base64');
  } catch {
    throw new Error(`hmacPacketSignerFromSecrets: ${name} is not valid base64`);
  }
  if (buf.length === 0) {
    throw new Error(`hmacPacketSignerFromSecrets: ${name} decoded to zero bytes`);
  }
  return buf;
}
