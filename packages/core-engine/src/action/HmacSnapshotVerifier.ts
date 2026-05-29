/**
 * F.1.9 — HmacSnapshotVerifier (+ paired HmacSnapshotSigner).
 *
 * HMAC-SHA256 over the canonical JSON form of TenantReadinessSnapshot.
 * The signature is the value stored in `sourceSig`; the signer computes
 * it, the verifier recomputes and compares constant-time.
 *
 * Canonical form
 * ──────────────
 *   - Object keys sorted lexicographically at every level.
 *   - No whitespace between tokens (JSON.stringify with no indent and
 *     custom key ordering).
 *   - The `sourceSig` field is OMITTED before signing/verifying
 *     (chicken-and-egg with the signature).
 *
 * Anti-replay
 * ───────────
 *   The snapshot includes a `snapshotAt` (ISO-8601) timestamp. The
 *   verifier rejects snapshots older than `SNAPSHOT_MAX_AGE_S` (default
 *   3600 = 1 hour). Long-running tasks that need to outlive the cap
 *   call CalibrationService.refresh() to re-sign without re-querying
 *   the underlying state.
 *
 *   In NODE_ENV !== 'production' the staleness check is skipped to
 *   accommodate dev clocks; the signature check still runs.
 *
 * Key rotation
 * ────────────
 *   Signer/verifier accept { primary, next? }.
 *     - sign()   always uses primary.
 *     - verify() accepts primary OR (when set) next.
 *
 *   Operator transition flow mirrors HmacPacketSigner (F.1.2):
 *     t0: primary=K1                 — signing + verifying with K1
 *     t1: primary=K1, next=K2        — deploy; verify accepts both
 *     t2: primary=K2, next=K1        — promote K2; old snapshots still verify
 *     t3: primary=K2                 — drop K1 once old snapshots aged out
 *
 * SecretsManager
 * ──────────────
 *   `hmacSnapshotVerifierFromSecrets(secrets)` reads
 *   `infra/calibration-signer` expecting
 *     { CALIBRATION_SIGNING_KEY: '<base64>',
 *       CALIBRATION_SIGNING_KEY_NEXT?: '<base64>' }.
 *   Missing primary throws — there is no insecure fallback. The same
 *   factory may be used to construct an HmacSnapshotSigner.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import type {
  ISnapshotSigner,
  ISnapshotVerifier,
  TenantReadinessSnapshot,
} from '@oweibo/core-contracts';
import type { SecretsManager } from '../secrets/SecretsManager.js';

const HEX_RE = /^[0-9a-f]+$/i;
const HEX_LEN = 64;  // SHA-256 → 32 bytes → 64 hex chars.

export const DEFAULT_SNAPSHOT_MAX_AGE_S = 3600;

export interface HmacSnapshotKeys {
  readonly primary: Buffer;
  readonly next?: Buffer;
}

export interface HmacSnapshotVerifierOptions {
  /** Override staleness check (seconds). Default 3600. */
  readonly maxAgeSeconds?: number;
  /** Override clock; tests pin time. */
  readonly now?: () => Date;
  /** Skip the staleness check entirely. Mostly for tests. */
  readonly skipStalenessCheck?: boolean;
  /**
   * When NODE_ENV !== 'production' the verifier skips the staleness
   * check by default. Set explicitly to override either way.
   */
  readonly env?: string;
}

export class HmacSnapshotVerifier implements ISnapshotVerifier {
  private readonly keys: HmacSnapshotKeys;
  private readonly maxAgeMs: number;
  private readonly now: () => Date;
  private readonly stalenessEnabled: boolean;

  constructor(keys: HmacSnapshotKeys, opts: HmacSnapshotVerifierOptions = {}) {
    validateKeys(keys);
    this.keys = keys;
    this.maxAgeMs = (opts.maxAgeSeconds ?? DEFAULT_SNAPSHOT_MAX_AGE_S) * 1000;
    this.now = opts.now ?? (() => new Date());
    const env = opts.env ?? process.env['NODE_ENV'] ?? 'development';
    this.stalenessEnabled = opts.skipStalenessCheck === undefined
      ? env === 'production'
      : !opts.skipStalenessCheck;
  }

  verify(snapshot: TenantReadinessSnapshot): boolean {
    if (!snapshot || typeof snapshot.sourceSig !== 'string') return false;
    if (!HEX_RE.test(snapshot.sourceSig) || snapshot.sourceSig.length !== HEX_LEN) return false;

    if (this.stalenessEnabled) {
      const snappedAt = Date.parse(snapshot.snapshotAt);
      if (!Number.isFinite(snappedAt)) return false;
      if (this.now().getTime() - snappedAt > this.maxAgeMs) return false;
    }

    const supplied = Buffer.from(snapshot.sourceSig, 'hex');
    if (supplied.length !== 32) return false;
    const canonical = canonicalize(snapshot);
    const expectedPrimary = Buffer.from(hmacHex(this.keys.primary, canonical), 'hex');
    if (constantTimeEq(supplied, expectedPrimary)) return true;
    if (this.keys.next) {
      const expectedNext = Buffer.from(hmacHex(this.keys.next, canonical), 'hex');
      if (constantTimeEq(supplied, expectedNext)) return true;
    }
    return false;
  }
}

export class HmacSnapshotSigner implements ISnapshotSigner {
  private readonly keys: HmacSnapshotKeys;
  constructor(keys: HmacSnapshotKeys) {
    validateKeys(keys);
    this.keys = keys;
  }
  sign(snapshot: Omit<TenantReadinessSnapshot, 'sourceSig'>): string {
    return hmacHex(this.keys.primary, canonicalize(snapshot));
  }
}

// ── Canonicalization ────────────────────────────────────────────────────

/**
 * Stable JSON form of the snapshot used for signing/verifying.
 *
 * - Drops `sourceSig`.
 * - Sorts object keys lexicographically at every level (including the
 *   nested actionClassScores map).
 * - Numbers are emitted via JSON.stringify's default (IEEE-754
 *   formatting). Operators MUST treat the snapshot as opaque bytes; any
 *   change to fields, ordering, or scaling breaks verification across
 *   versions.
 *
 * The exported `canonicalizeSnapshotForSigning` lets sibling code reuse
 * the same form (tests, future debug tools).
 */
export function canonicalizeSnapshotForSigning(
  snapshot: Omit<TenantReadinessSnapshot, 'sourceSig'> | TenantReadinessSnapshot,
): string {
  return canonicalize(snapshot);
}

function canonicalize(snapshot: Partial<TenantReadinessSnapshot> & Omit<TenantReadinessSnapshot, 'sourceSig'>): string {
  return stableStringify({
    tenantId:          snapshot.tenantId,
    accountAgeDays:    snapshot.accountAgeDays,
    actionClassScores: snapshot.actionClassScores,
    snapshotAt:        snapshot.snapshotAt,
  });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function hmacHex(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('hex');
}

function constantTimeEq(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function validateKeys(keys: HmacSnapshotKeys): void {
  if (!keys.primary || keys.primary.length === 0) {
    throw new Error('HmacSnapshotVerifier: primary key required');
  }
  if (keys.primary.length < 16) {
    throw new Error(`HmacSnapshotVerifier: primary key too short (${keys.primary.length} bytes; need >= 16)`);
  }
  if (keys.next && keys.next.length > 0 && keys.next.length < 16) {
    throw new Error(`HmacSnapshotVerifier: next key too short (${keys.next.length} bytes; need >= 16)`);
  }
}

// ── SecretsManager factory ──────────────────────────────────────────────

interface SnapshotSignerSecrets {
  readonly CALIBRATION_SIGNING_KEY?: unknown;
  readonly CALIBRATION_SIGNING_KEY_NEXT?: unknown;
}

/**
 * Construct a verifier (or paired signer) from `infra/calibration-signer`
 * via SecretsManager. Expected payload shape:
 *
 *   { "CALIBRATION_SIGNING_KEY":      "<base64 primary>",
 *     "CALIBRATION_SIGNING_KEY_NEXT": "<base64 rotation>"  // optional }
 *
 * Missing primary throws — there is no insecure fallback.
 */
export async function loadHmacSnapshotKeys(secrets: SecretsManager): Promise<HmacSnapshotKeys> {
  const raw = (await secrets.getInfraCredentials('calibration-signer')) as SnapshotSignerSecrets | null;
  if (!raw) {
    throw new Error(
      "loadHmacSnapshotKeys: infra/calibration-signer not found in Vault. " +
      "Store { CALIBRATION_SIGNING_KEY: '<base64>' } before enabling " +
      "snapshot verification.",
    );
  }
  const primary = decodeBase64Key(raw.CALIBRATION_SIGNING_KEY, 'CALIBRATION_SIGNING_KEY');
  const next = raw.CALIBRATION_SIGNING_KEY_NEXT !== undefined && raw.CALIBRATION_SIGNING_KEY_NEXT !== null
    ? decodeBase64Key(raw.CALIBRATION_SIGNING_KEY_NEXT, 'CALIBRATION_SIGNING_KEY_NEXT')
    : undefined;
  return next !== undefined ? { primary, next } : { primary };
}

export async function hmacSnapshotVerifierFromSecrets(
  secrets: SecretsManager,
  opts: HmacSnapshotVerifierOptions = {},
): Promise<HmacSnapshotVerifier> {
  const keys = await loadHmacSnapshotKeys(secrets);
  return new HmacSnapshotVerifier(keys, opts);
}

export async function hmacSnapshotSignerFromSecrets(
  secrets: SecretsManager,
): Promise<HmacSnapshotSigner> {
  const keys = await loadHmacSnapshotKeys(secrets);
  return new HmacSnapshotSigner(keys);
}

function decodeBase64Key(value: unknown, name: string): Buffer {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`loadHmacSnapshotKeys: ${name} missing or not a string`);
  }
  const buf = Buffer.from(value, 'base64');
  if (buf.length === 0) {
    throw new Error(`loadHmacSnapshotKeys: ${name} decoded to zero bytes`);
  }
  return buf;
}
