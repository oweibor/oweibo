export interface ILogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

const GLOB_MAX_LENGTH  = 256;
const GLOB_MAX_STARS   = 3;
const NESTED_REPEAT_RE = /(\*{2,}|\+\([^)]*\)|\{[^}]*\})\s*(\*|\+|\?|\{)/;

/**
 * Validates user-supplied glob patterns against ReDoS and length constraints (C12, v10.5).
 * Returns only valid patterns; drops the rest with a GLOB_PATTERN_INVALID warn log.
 */
export function validateGlobPatterns(
  patterns: readonly string[],
  logger:   ILogger,
): readonly string[] {
  const valid: string[] = [];
  for (const p of patterns) {
    if (p.length > GLOB_MAX_LENGTH) {
      logger.warn({ pattern: p.slice(0, 32) }, 'GLOB_PATTERN_INVALID: exceeds max length');
      continue;
    }
    if ((p.match(/\*\*/g) ?? []).length > GLOB_MAX_STARS) {
      logger.warn({ pattern: p }, 'GLOB_PATTERN_INVALID: too many ** segments');
      continue;
    }
    if (NESTED_REPEAT_RE.test(p)) {
      logger.warn({ pattern: p }, 'GLOB_PATTERN_INVALID: nested repetition (ReDoS risk)');
      continue;
    }
    valid.push(p);
  }
  return valid;
}
