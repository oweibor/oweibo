/**
 * K.1 convention (ADR-012 §3.5, arch §4.1) — webhook signature
 * verification. Provided by the SDK so no adapter hand-rolls HMAC
 * comparison (the classic timing-oracle mistake); an adapter that
 * reimplements this is the complexity gate firing early (§3.6).
 *
 * Scheme: HMAC-SHA256 over the raw request body with the per-instance
 * webhook secret, hex-encoded. Sources with their own scheme (e.g.
 * base64, prefixed `sha256=`) normalize the received value before
 * calling; sources with fundamentally different verification (asymmetric
 * signatures, JWT-signed payloads) verify in adapter code — this helper
 * covers the overwhelmingly common case, not every case.
 */
import { createHmac, timingSafeEqual } from 'crypto';

/** Compute the expected hex HMAC-SHA256 signature for a raw body. */
export function computeWebhookSignature(rawBody: string | Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Constant-time verification of a received signature. Length is checked
 * first because timingSafeEqual throws on mismatch — and the attacker
 * controls the received value, so that exception must not become the
 * timing leak.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  receivedSignatureHex: string,
  secret: string,
): boolean {
  const expected = Buffer.from(computeWebhookSignature(rawBody, secret), 'utf8');
  const received = Buffer.from(receivedSignatureHex, 'utf8');
  return expected.length === received.length && timingSafeEqual(expected, received);
}
