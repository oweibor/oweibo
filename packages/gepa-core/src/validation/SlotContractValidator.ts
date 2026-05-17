// §7.1 / §8.4 step 2.5 — SlotContractValidator
// Enforces machine-checkable structural invariants on mutation candidates
// before they enter the eval queue.
//
// Called after the egress DLP gate and before eval (line 919 pseudocode).
// Violations logged to gepa_contract_violation_total{slot_id} and rejected
// without consuming an eval run.

export type SlotShape = 'numbered-list' | 'prose-block' | 'json-object' | 'free';
export type EndsWithConstraint = 'imperative' | 'period' | 'any';

/** Machine-checkable structural invariants for a prompt slot. */
export interface SlotContract {
  readonly shape:            SlotShape;
  readonly forbid_urls:      boolean;
  readonly forbid_identifiers: boolean;  // additional ban beyond DLP filter
  readonly must_reference:   readonly string[];   // tokens that must appear
  readonly must_not_contain: readonly string[];   // banned phrases
  readonly ends_with:        EndsWithConstraint;
  readonly max_items?:       number;              // for numbered-list shape
}

export interface ContractCheckResult {
  readonly pass:    boolean;
  readonly reason:  string | null;  // null when pass=true
}

// ── Shape validators ─────────────────────────────────────────────────────────

function checkNumberedList(text: string, maxItems?: number): string | null {
  const lines = text.trim().split('\n').filter(l => l.trim().length > 0);
  // At least one line must start with a number+period or number+dot
  const listLines = lines.filter(l => /^\s*\d+[.)]\s+/.test(l));
  if (listLines.length === 0) return 'shape:numbered-list — no numbered lines found';
  if (maxItems !== undefined && listLines.length > maxItems) {
    return `shape:numbered-list — ${listLines.length} items exceeds max_items=${maxItems}`;
  }
  return null;
}

function checkJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return 'shape:json-object — text must start with { and end with }';
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return 'shape:json-object — parsed value is not a JSON object';
    }
  } catch {
    return 'shape:json-object — invalid JSON';
  }
  return null;
}

// ── URL / identifier detection ────────────────────────────────────────────────

const URL_RE  = /https?:\/\/\S+/i;
const IDENT_RE = new RegExp([
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,  // UUID
  /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/,                  // email
  /\b(?:\/(?:usr|var|home|etc|tmp|app|opt|srv|mnt)\b)[^\s]*/,               // Unix absolute path
  /\b[A-Z][A-Z0-9_]{5,}\b/,                                                  // SCREAMING_CONST (likely API key or env var name)
  /\b[0-9a-f]{40,}\b/i,                                                      // sha1/sha256 hex
].map(r => r.source).join('|'), 'i');

// ── Ends-with validators ──────────────────────────────────────────────────────

function checkEndsWith(text: string, constraint: EndsWithConstraint): string | null {
  if (constraint === 'any') return null;
  const last = text.trimEnd();
  if (constraint === 'period') {
    if (!last.endsWith('.')) return `ends_with:period — last non-whitespace char is not '.'`;
  }
  if (constraint === 'imperative') {
    // Last sentence should start with a verb (imperative mood).
    // Heuristic: last sentence first word is a known imperative verb or is Title-case + short.
    const sentences = last.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
    const lastSentence = (sentences[sentences.length - 1] ?? '').trim();
    const firstWord = lastSentence.split(/\s+/)[0] ?? '';
    const IMPERATIVE_VERBS = new Set([
      'use', 'always', 'never', 'ensure', 'avoid', 'prefer', 'check', 'verify',
      'validate', 'include', 'exclude', 'consider', 'prioritise', 'prioritize',
      'output', 'format', 'provide', 'return', 'list', 'explain', 'describe',
      'analyze', 'analyse', 'respond', 'reply', 'write', 'generate', 'produce',
      'apply', 'follow', 'do', 'don\'t', 'make', 'keep', 'focus', 'limit',
    ]);
    if (!IMPERATIVE_VERBS.has(firstWord.toLowerCase().replace(/[^a-z']/gi, ''))) {
      return `ends_with:imperative — last sentence ('${firstWord}...') does not begin with an imperative verb`;
    }
  }
  return null;
}

// ── Main validator ────────────────────────────────────────────────────────────

/**
 * Validates a mutation candidate text against a slot contract.
 * Returns pass=true if all constraints are satisfied.
 * Returns pass=false with a reason string on the first violation.
 */
export function validateSlotContract(
  text:     string,
  contract: SlotContract,
): ContractCheckResult {
  // Shape check
  if (contract.shape === 'numbered-list') {
    const err = checkNumberedList(text, contract.max_items);
    if (err) return { pass: false, reason: err };
  }
  if (contract.shape === 'json-object') {
    const err = checkJsonObject(text);
    if (err) return { pass: false, reason: err };
  }
  // 'prose-block' and 'free' have no structural shape constraint

  // URL check
  if (contract.forbid_urls && URL_RE.test(text)) {
    return { pass: false, reason: 'forbid_urls — text contains a URL' };
  }

  // Identifier check
  if (contract.forbid_identifiers && IDENT_RE.test(text)) {
    return { pass: false, reason: 'forbid_identifiers — text contains an identifier (UUID, email, path, or hash)' };
  }

  // must_reference tokens
  for (const token of contract.must_reference) {
    if (!text.includes(token)) {
      return { pass: false, reason: `must_reference — required token '${token}' not found` };
    }
  }

  // must_not_contain phrases
  for (const phrase of contract.must_not_contain) {
    if (text.toLowerCase().includes(phrase.toLowerCase())) {
      return { pass: false, reason: `must_not_contain — banned phrase '${phrase}' found` };
    }
  }

  // ends_with constraint
  const endErr = checkEndsWith(text, contract.ends_with);
  if (endErr) return { pass: false, reason: endErr };

  return { pass: true, reason: null };
}

/**
 * Default permissive contract — used when no slot-specific contract is defined.
 * Still blocks URLs and identifiers as a baseline.
 */
export const DEFAULT_SLOT_CONTRACT: SlotContract = {
  shape:             'free',
  forbid_urls:       true,
  forbid_identifiers: false,
  must_reference:    [],
  must_not_contain:  [],
  ends_with:         'any',
};
