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
 *
 * Heuristic limits: SQL comments and string literals are NOT stripped,
 * so a comment containing `DROP TABLE` will false-positive. Operators
 * can disable the inspector per-tenant if they hit this.
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
    const upper = sql.toUpperCase();
    const stripped = stripStringLiterals(upper);

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
