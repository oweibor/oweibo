/**
 * authorize — per-route scope enforcement, layered on top of `authenticate`.
 *
 * `authenticate` proves *who* the caller is and populates `req.scopes` (from
 * the identity token's `scopes` claim, expanded from the caller's roles in
 * apps/identity/src/policy.ts). This middleware proves the caller is *allowed*
 * to perform the request.
 *
 * `requireScopes` is method-aware: read methods (GET/HEAD/OPTIONS) are checked
 * against the `read` set, mutating methods (POST/PUT/PATCH/DELETE) against the
 * `write` set. That lets a single mount-level guard cover a whole router while
 * still distinguishing viewers from editors. Semantics are ANY-of by default
 * (holding any one listed scope passes); pass `all: true` to require every
 * listed scope.
 *
 * A `platform_admin` / `tenant_admin` token carries the full scope set for its
 * layer, so admin flows pass everywhere; `tenant_developer` / `tenant_viewer`
 * are limited as their role dictates.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { AuthenticatedRequest } from './authenticate.js';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface ScopeRule {
  /** Scopes accepted on read methods (GET/HEAD/OPTIONS). */
  read?: readonly string[];
  /** Scopes accepted on mutating methods (POST/PUT/PATCH/DELETE). */
  write?: readonly string[];
  /** Require ALL listed scopes instead of ANY-of (default false). */
  all?: boolean;
}

/**
 * @param rule Either a `ScopeRule` (method-aware) or a flat scope list applied
 *             to every method.
 */
export function requireScopes(rule: ScopeRule | readonly string[]): RequestHandler {
  const normalized: ScopeRule = Array.isArray(rule)
    ? { read: rule as readonly string[], write: rule as readonly string[] }
    : (rule as ScopeRule);

  return (req: Request, res: Response, next: NextFunction): void => {
    const have = new Set((req as AuthenticatedRequest).scopes ?? []);
    const required = READ_METHODS.has(req.method) ? normalized.read : normalized.write;

    // No requirement configured for this method class → authentication alone
    // is sufficient (auth middleware has already run).
    if (!required || required.length === 0) {
      next();
      return;
    }

    const satisfied = normalized.all
      ? required.every((s) => have.has(s))
      : required.some((s) => have.has(s));

    if (!satisfied) {
      res.status(403).json({
        error: 'insufficient_scope',
        message: `requires ${normalized.all ? 'all of' : 'one of'}: ${required.join(', ')}`,
        required,
      });
      return;
    }
    next();
  };
}
