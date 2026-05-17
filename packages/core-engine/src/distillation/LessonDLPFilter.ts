// DONE: Phase B.2 — LessonDLPFilter with regex/entropy/denylist suite.
// Pure functions only — zero LLM calls, zero I/O.
// Adversarial fixtures are tested in __tests__/LessonDLPFilter.test.ts.

// ── Regex patterns for identifiable data ─────────────────────────────────────

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  // UUIDs
  { name: 'uuid',        re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  // Email addresses
  { name: 'email',       re: /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/ },
  // IPv4 addresses
  { name: 'ipv4',        re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
  // IPv6 (full form)
  { name: 'ipv6',        re: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/ },
  // Filesystem paths (Unix + Windows)
  { name: 'unix_path',   re: /(?:^|\s)\/(?:[a-zA-Z0-9._\-]+\/)+[a-zA-Z0-9._\-]+/ },
  { name: 'win_path',    re: /\b[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]+/ },
  // Git commit SHAs (40-char hex)
  { name: 'git_sha',     re: /\b[0-9a-f]{40}\b/i },
  // Short SHA (7+ hex chars that look like a commit ref)
  { name: 'short_sha',   re: /\b[0-9a-f]{7,12}\b/i },
  // AWS ARNs
  { name: 'aws_arn',     re: /arn:[a-z0-9\-]+:[a-z0-9\-]+:[a-z0-9\-]*:[0-9]{12}:[^\s]+/ },
  // Private keys / API key patterns
  { name: 'api_key',     re: /(?:sk|pk|api|key|token|secret|auth)[-_]?[a-zA-Z0-9]{16,}/i },
  // Base64 blobs ≥32 chars (likely encoded identifiers/tokens)
  { name: 'base64_blob', re: /[A-Za-z0-9+/]{32,}={0,2}/ },
  // Postgres-style OIDs or numeric IDs > 8 digits
  { name: 'numeric_id',  re: /\b\d{9,}\b/ },
  // URL with scheme (contains host → potentially identifying)
  { name: 'url',         re: /https?:\/\/[^\s"'<>]{4,}/ },
  // Zero-width space split identifiers (adversarial)
  { name: 'zws_split',   re: /​|‌|‍|﻿/ },
];

// ── Denylist terms ────────────────────────────────────────────────────────────

const DENYLIST_TERMS = new Set([
  'password', 'passwd', 'secret', 'credential', 'private_key', 'privatekey',
  'access_token', 'refresh_token', 'bearer', 'authorization', 'x-api-key',
  'ssn', 'social security', 'credit card', 'card number', 'cvv',
]);

// ── Shannon entropy ───────────────────────────────────────────────────────────

function shannonEntropy(s: string): number {
  const freq: Record<string, number> = {};
  for (const ch of s) freq[ch] = (freq[ch] ?? 0) + 1;
  const len = s.length;
  let entropy = 0;
  for (const count of Object.values(freq)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Entropy threshold above which a word-token is flagged as high-entropy. */
const HIGH_ENTROPY_THRESHOLD = 4.5;
/** Minimum word length to apply entropy check. */
const ENTROPY_MIN_WORD_LEN = 20;

function hasHighEntropyToken(text: string): boolean {
  for (const word of text.split(/\s+/)) {
    if (word.length >= ENTROPY_MIN_WORD_LEN &&
        shannonEntropy(word) >= HIGH_ENTROPY_THRESHOLD) {
      return true;
    }
  }
  return false;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface DLPResult {
  readonly pass: boolean;
  /** Reasons for rejection (empty when pass === true). */
  readonly rejections: readonly string[];
}

/**
 * Validate that `text` contains no identifiable data.
 * Returns pass=true only when ALL checks pass.
 */
export function applyDLPFilter(text: string): DLPResult {
  const rejections: string[] = [];

  for (const { name, re } of PATTERNS) {
    if (re.test(text)) rejections.push(`pattern:${name}`);
  }

  const lower = text.toLowerCase();
  for (const term of DENYLIST_TERMS) {
    if (lower.includes(term)) rejections.push(`denylist:${term}`);
  }

  if (hasHighEntropyToken(text)) rejections.push('entropy:high_entropy_token');

  return { pass: rejections.length === 0, rejections };
}

/**
 * Strip known-identifiable patterns from text before the confidentiality
 * classifier runs. Returns the sanitised string.
 * This is a best-effort pre-processor — applyDLPFilter MUST still pass on output.
 */
export function sanitise(text: string): string {
  let out = text;
  // Remove zero-width characters
  out = out.replace(/[​‌‍﻿]/g, '');
  // Remove URLs
  out = out.replace(/https?:\/\/[^\s"'<>]{4,}/g, '<URL>');
  // Remove UUIDs
  out = out.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<ID>');
  // Remove email
  out = out.replace(/\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g, '<EMAIL>');
  // Remove IPv4
  out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<IP>');
  // Remove git SHAs
  out = out.replace(/\b[0-9a-f]{40}\b/gi, '<SHA>');
  return out;
}
