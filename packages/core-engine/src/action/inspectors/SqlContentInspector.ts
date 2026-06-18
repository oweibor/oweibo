/**
 * S.5.a: SqlContentInspector — flags dangerous SQL constructs in payloads
 * for `write.tenant_db.*` action classes.
 *
 * Detection is heuristic (no full SQL parser dep); we look for the
 * specific patterns that have historically caused outages:
 *
 *   * `DROP TABLE`, `DROP DATABASE`, `DROP SCHEMA` — outright forbid
 *   * `TRUNCATE TABLE` — outright forbid
 *   * `DELETE` without `WHERE`, or `WHERE 1=1` / `WHERE TRUE` — forbid
 *   * `UPDATE` without `WHERE`, or with always-true predicate — forbid
 *   * `ALTER TABLE … DROP COLUMN` — upgrade_to_approval
 *   * `GRANT`/`REVOKE` statements — upgrade_to_approval
 *   * Multi-statement batches where any later statement matches a
 *     forbid pattern — forbid (audit-fix S.5)
 *   * Unicode-fullwidth characters mimicking ASCII keywords — forbid
 *
 * Audit-fix (S.5): pre-process the SQL to defeat the known
 * regex-bypass classes the audit identified:
 *   1. Strip `--` line comments and `/* … *\/` block comments before
 *      pattern matching (so `DELETE /* WHERE x *\/ FROM users` no
 *      longer passes the WHERE check).
 *   2. NFKC-normalize Unicode so `ＤＲＯＰ TABLE` (fullwidth) collapses
 *      to `DROP TABLE` for detection.
 *   3. Walk EVERY statement (split on `;` after comments are stripped
 *      and string literals are masked), not just the first.
 *
 * Operators can disable the inspector per-tenant if false positives
 * become an issue. The audit's stronger recommendation (full
 * pg-query-parser AST walk) remains a follow-up; for now these
 * heuristics close the documented bypass classes without adding a
 * runtime dep.
 */
import type {
  ActionContext,
  ContentInspectionResult,
  IContentInspector,
} from '@oweibo/core-contracts';

export class SqlContentInspector implements IContentInspector {
  readonly name = 'sql_content';

  appliesTo(actionClass: string): boolean {
    return actionClass.startsWith('write.tenant_db.');
  }

  async inspect(ctx: ActionContext): Promise<ContentInspectionResult> {
    const sql = extractSql(ctx.payload);
    if (!sql) return { verdict: 'allow' };

    // Audit-fix (S.5): preprocess to defeat known bypass classes.
    //   1. NFKC-normalize — fullwidth `ＤＲＯＰ` → `DROP`.
    //   2. Strip comments — `--` line + `/* ... */` block.
    //   3. Uppercase + mask string literals so keyword regexes don't
    //      false-match string contents.
    const preprocessed = preprocess(sql);
    // Walk EVERY statement in the batch, not just the first.
    const statements = splitStatements(preprocessed);

    let worstVerdict: ContentInspectionResult = { verdict: 'allow' };
    for (const stmt of statements) {
      const v = inspectOne(stmt);
      if (v.verdict === 'forbid') return v;
      if (v.verdict === 'upgrade_to_approval' && worstVerdict.verdict !== 'upgrade_to_approval') {
        worstVerdict = v;
      }
    }
    return worstVerdict;
  }
}

function inspectOne(stripped: string): ContentInspectionResult {
  // Outright destructive operations.
  if (/\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/.test(stripped)) {
    return {
      verdict: 'forbid',
      reason: 'DROP TABLE/DATABASE/SCHEMA is never allowed via the action layer',
      details: { matched: 'DROP_TABLE_OR_SCHEMA' },
    };
  }
  if (/\bTRUNCATE\s+TABLE\b/.test(stripped)) {
    return {
      verdict: 'forbid',
      reason: 'TRUNCATE TABLE bypasses row-level audit and is forbidden',
      details: { matched: 'TRUNCATE' },
    };
  }
  // DELETE / UPDATE without WHERE.
  if (/\bDELETE\s+FROM\b/.test(stripped) && !hasUsefulWhere(stripped, 'DELETE')) {
    return {
      verdict: 'forbid',
      reason: 'DELETE without a meaningful WHERE clause',
      details: { matched: 'DELETE_NO_WHERE' },
    };
  }
  if (/\bUPDATE\s+\w/.test(stripped) && !hasUsefulWhere(stripped, 'UPDATE')) {
    return {
      verdict: 'forbid',
      reason: 'UPDATE without a meaningful WHERE clause',
      details: { matched: 'UPDATE_NO_WHERE' },
    };
  }
  // Schema-altering operations — require operator review.
  if (/\bALTER\s+TABLE\s+\S+\s+DROP\s+COLUMN\b/.test(stripped)) {
    return {
      verdict: 'upgrade_to_approval',
      reason: 'ALTER TABLE DROP COLUMN requires operator approval',
      details: { matched: 'DROP_COLUMN' },
    };
  }
  if (/\b(GRANT|REVOKE)\s+/.test(stripped)) {
    return {
      verdict: 'upgrade_to_approval',
      reason: 'GRANT/REVOKE requires operator approval',
      details: { matched: 'GRANT_OR_REVOKE' },
    };
  }
  return { verdict: 'allow' };
}

/**
 * Audit-fix (S.5): full preprocessing pipeline. The order matters:
 * Unicode normalization MUST run before comment-stripping (so a
 * fullwidth `--` is also recognized as a comment); string-literal
 * masking MUST run after comment-stripping (so a string literal
 * inside a stripped comment isn't masked twice).
 */
function preprocess(sql: string): string {
  const normalized = sql.normalize('NFKC');
  const noComments = stripComments(normalized);
  const upper = noComments.toUpperCase();
  return stripStringLiterals(upper);
}

function stripComments(sql: string): string {
  // Block comments first (they may span multiple lines), then line comments.
  // Greedy minimum-match prevents one block comment swallowing the rest of
  // the file.
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

function splitStatements(sql: string): string[] {
  // Naive `;` split — adequate after string literals are masked because
  // the masking replaces `'...;...'` with `''`. Empty / whitespace-only
  // statements are dropped.
  return sql.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
}

function extractSql(payload: unknown): string | null {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    if (typeof obj['sql'] === 'string') return obj['sql'] as string;
    if (typeof obj['query'] === 'string') return obj['query'] as string;
    if (typeof obj['statement'] === 'string') return obj['statement'] as string;
  }
  return null;
}

function stripStringLiterals(sql: string): string {
  // Strip single-quoted strings — minimal handling. Misses dollar-quoted
  // strings and escaped quotes; we accept the false-positive risk and
  // expose the per-tenant disable knob in the policy.
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

function hasUsefulWhere(sql: string, verb: 'DELETE' | 'UPDATE'): boolean {
  const re = new RegExp(`\\b${verb}\\b[\\s\\S]*?\\bWHERE\\b([\\s\\S]+)`, 'i');
  const m = sql.match(re);
  if (!m) return false;
  const where = m[1] ?? '';
  // Always-true predicates we explicitly reject.
  if (/\bWHERE\s+1\s*=\s*1\b/.test(sql)) return false;
  if (/\bWHERE\s+TRUE\b/.test(sql)) return false;
  // A literal WHERE followed by nothing meaningful is empty.
  return /\w/.test(where);
}
