// §5.4 / §8.5 — PromptInstructionShapeValidator
// Rejects mutation output that contains instruction-shaped constructs.
// Closes audit gap B-02: prompt injection on the GEPA reflection LLM.
//
// Called in GEPAOptimizer before any candidate enters the eval queue (line 918 pseudocode).
// Judge prompts also strip text matching this denylist before evaluation (§8.5).

export interface ShapeCheckResult {
  readonly pass:        boolean;
  readonly matchedRule: string | null;  // null when pass=true
}

// Patterns that look like instruction-injection attempts.
// Anchored loosely so we catch obfuscated variants (leading whitespace, punctuation).
const DENYLIST: Array<{ label: string; re: RegExp }> = [
  { label: 'ignore_previous',    re: /ignore\s+(?:previous|prior|above|all\s+(?:previous|prior|above))/i },
  { label: 'system_colon',       re: /^\s*system\s*:/im },
  { label: 'you_are_now',        re: /\byou\s+are\s+now\b/i },
  { label: 'override_directive', re: /\boverride\s+(?:all\s+)?(?:previous|prior|above|instructions?|directives?|rules?|guidelines?)\b/i },
  { label: 'new_instructions',   re: /\bnew\s+instructions?\s*[:：]/i },
  { label: 'disregard',          re: /\bdisregard\s+(?:all\s+)?(?:previous|prior|above|instructions?)\b/i },
  { label: 'forget_previous',    re: /\bforget\s+(?:all\s+)?(?:previous|prior|above|everything|instructions?)\b/i },
  { label: 'act_as',            re: /\bact\s+as\s+(?:if\s+you\s+(?:are|were)\s+)?(?:a\s+)?(?:different|unrestricted|unfiltered|jailbroken)\b/i },
  { label: 'jailbreak',          re: /\bjailbreak\b/i },
  { label: 'do_anything_now',    re: /\bdo\s+anything\s+now\b/i },
  { label: 'dan_mode',           re: /\bdan\s+mode\b/i },
  { label: 'end_of_system',      re: /<\/?\s*system\s*>/i },
  { label: 'human_tag',          re: /<\/?\s*(?:human|assistant|user)\s*>/i },
  { label: 'roleplay_prompt',    re: /\bpretend\s+(?:you\s+are|to\s+be)\s+(?:an?\s+)?(?:AI|assistant|language\s+model)\s+without\b/i },
];

/**
 * Returns pass=true if the mutation text is free of instruction-shaped constructs.
 * Returns pass=false with the matched rule name on first violation found.
 *
 * Does NOT throw — callers check the result and reject the candidate.
 */
export function acceptsInstructionShape(text: string): ShapeCheckResult {
  for (const { label, re } of DENYLIST) {
    if (re.test(text)) {
      return { pass: false, matchedRule: label };
    }
  }
  return { pass: true, matchedRule: null };
}

/**
 * Strip any text segments matching the denylist (used by judge prompts per §8.5).
 * Each matching segment is replaced with [REDACTED].
 */
export function stripInstructionShapes(text: string): string {
  let out = text;
  for (const { re } of DENYLIST) {
    // Replace globally; flags already set on each pattern, add 'g' via source
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    out = out.replace(global, '[REDACTED]');
  }
  return out;
}
