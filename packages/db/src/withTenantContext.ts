import { prisma } from './client.js';
import type { Principal, PrismaTx } from './types.js';

/**
 * Thrown when withTenantContext's pre-transaction cross-check finds that the
 * principal's claimed `ctx.tenantId` is not authoritatively bound in the DB:
 *   - user has no membership in that tenant
 *   - api_key is revoked / expired / bound to a different tenant
 *   - agent's actAs membership is missing
 *   - agent's actAs.tenantId disagrees with ctx.tenantId
 *
 * A signed JWT proves the IdP issued the claim at some point. It does NOT
 * prove the binding is still valid right now. This error fires when the JWT
 * disagrees with the authoritative DB state — typically a stale token after
 * a membership revocation or an outright forgery.
 */
export class TenantBindingError extends Error {
  override readonly name = 'TenantBindingError';
  constructor(
    message: string,
    readonly kind: 'user' | 'api_key' | 'agent',
    readonly subject: string,
    readonly tenantId: string,
  ) {
    super(message);
  }
}

// ── In-process binding cache ────────────────────────────────────────────────
//
// Keyed by (cacheKind, subject, tenantId). `cacheKind` is 'user' or 'api_key'
// — the listener's NOTIFY payload uses the same two values, so the listener's
// _invalidateTenantBinding() can target an entry without consulting the
// principal it came from. Agent paths store the entry under their actAs
// user, so a revoked actAs membership evicts the agent's cached entry too.
//
// TTL is 60 s. Sub-second propagation is provided by tenantBindingListener
// (LISTEN/NOTIFY); the TTL is the worst-case fallback when the listener is
// not running or has just reconnected.

type CacheKind = 'user' | 'api_key';
const TTL_MS = 60_000;
const bindingCache = new Map<string, { ok: boolean; ts: number }>();

function cacheKey(kind: CacheKind, subject: string, tenantId: string): string {
  return `${kind}:${subject}:${tenantId}`;
}

function cacheGet(kind: CacheKind, subject: string, tenantId: string): boolean | null {
  const entry = bindingCache.get(cacheKey(kind, subject, tenantId));
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) {
    bindingCache.delete(cacheKey(kind, subject, tenantId));
    return null;
  }
  return entry.ok;
}

function cachePut(kind: CacheKind, subject: string, tenantId: string, ok: boolean): void {
  bindingCache.set(cacheKey(kind, subject, tenantId), { ok, ts: Date.now() });
}

/**
 * Evict a single binding entry. Used by tenantBindingListener on NOTIFY.
 * No-op if the entry isn't cached.
 */
export function _invalidateTenantBinding(
  kind: CacheKind,
  subject: string,
  tenantId: string,
): void {
  bindingCache.delete(cacheKey(kind, subject, tenantId));
}

/**
 * Drop every cached binding. Used by the listener on (re)connect to recover
 * from any missed notifications during the disconnect window, and by tests.
 */
export function _clearTenantBindingCache(): void {
  bindingCache.clear();
}

// ── DB cross-check ──────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f-]{36}$/i;

interface DbCheck {
  readonly kind:     CacheKind;
  /** UUID to pass to the SECURITY DEFINER function. */
  readonly subject:  string;
  readonly tenantId: string;
}

/**
 * Derive the (kind, subject, tenantId) tuple to verify from a Principal.
 * Returns null when the principal is malformed (e.g. agent without actAs,
 * unparseable api-key sub) — caller treats null as a binding failure.
 *
 * The agent path verifies against actAs membership AND rejects an
 * inconsistent actAs.tenantId vs ctx.tenantId. The check enforces the
 * "agent acts only inside the tenant whose user it impersonates" invariant.
 */
function deriveDbCheck(principal: Principal): DbCheck | null {
  const tenantId = principal.ctx.tenantId;
  if (!tenantId || !UUID_RE.test(tenantId)) return null;

  switch (principal.kind) {
    case 'user': {
      const userId = principal.sub;
      if (!UUID_RE.test(userId)) return null;
      return { kind: 'user', subject: userId, tenantId };
    }
    case 'api_key': {
      // sub format: 'apikey:<uuid>' (per resolveApiKey in api-middleware).
      const prefix = 'apikey:';
      if (!principal.sub.startsWith(prefix)) return null;
      const keyId = principal.sub.slice(prefix.length);
      if (!UUID_RE.test(keyId)) return null;
      return { kind: 'api_key', subject: keyId, tenantId };
    }
    case 'agent': {
      const actAs = principal.actAs;
      if (!actAs) return null;
      if (actAs.tenantId !== tenantId) return null;  // inconsistent
      if (!UUID_RE.test(actAs.sub)) return null;
      return { kind: 'user', subject: actAs.sub, tenantId };
    }
  }
}

async function checkBindingInDb(check: DbCheck): Promise<boolean> {
  // SECURITY DEFINER functions from migration 20260519_000018; bypass RLS
  // internally and return only a boolean — no row data leaks to a caller
  // probing for memberships.
  if (check.kind === 'user') {
    const rows = await prisma.$queryRaw<{ ok: boolean }[]>`
      SELECT oweibo.user_has_membership(${check.subject}::uuid, ${check.tenantId}::uuid) AS ok
    `;
    return rows[0]?.ok === true;
  }
  const rows = await prisma.$queryRaw<{ ok: boolean }[]>`
    SELECT oweibo.api_key_valid(${check.subject}::uuid, ${check.tenantId}::uuid) AS ok
  `;
  return rows[0]?.ok === true;
}

/**
 * The single entry point for all oweibo.* database queries.
 *
 * Cross-checks the principal's claimed `ctx.tenantId` against authoritative
 * DB state before opening the RLS-scoped transaction. Throws TenantBindingError
 * on mismatch; otherwise sets the Postgres session parameters and runs `fn`.
 *
 * Session parameters set inside the transaction:
 *   app.tenant_id        — activates the tenant_isolation RLS policy
 *   app.is_platform_admin — activates the platform_admin_bypass RLS policy
 *   app.user_id          — activates the self_read policy on oweibo.users
 *
 * All three are SET LOCAL (transaction-scoped) so they don't leak across
 * connections when using PgBouncer in transaction-pool mode.
 *
 * Bypass: principals with the `platform:tenants:write` scope skip the
 * binding check (operator escalation path). The platform_admin RLS policy
 * still enforces what those queries can read.
 *
 * ESLint rule no-direct-prisma.js blocks prisma.* access outside this file.
 */
export async function withTenantContext<T>(
  principal: Principal,
  fn: (tx: PrismaTx) => Promise<T>,
): Promise<T> {
  const isPlatformAdmin = principal.scopes.includes('platform:tenants:write');
  const tenantId = principal.ctx.tenantId;
  const userId = principal.sub.startsWith('agent:')
    ? principal.actAs?.sub ?? principal.sub
    : principal.sub;

  // Pre-transaction binding check (skipped for platform-admin scope).
  if (!isPlatformAdmin) {
    const check = deriveDbCheck(principal);
    if (!check) {
      throw new TenantBindingError(
        `principal kind=${principal.kind} is malformed or missing required actAs/sub binding`,
        principal.kind,
        principal.sub,
        tenantId ?? '',
      );
    }
    const cached = cacheGet(check.kind, check.subject, check.tenantId);
    let ok: boolean;
    if (cached === null) {
      ok = await checkBindingInDb(check);
      cachePut(check.kind, check.subject, check.tenantId, ok);
    } else {
      ok = cached;
    }
    if (!ok) {
      throw new TenantBindingError(
        `principal kind=${principal.kind} sub=${principal.sub} is not bound to tenant ${check.tenantId}`,
        principal.kind,
        principal.sub,
        check.tenantId,
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    if (tenantId) {
      // tenantId is guaranteed UUID-shaped by upstream Zod validation.
      await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
    }
    if (isPlatformAdmin) {
      await tx.$executeRawUnsafe(`SET LOCAL app.is_platform_admin = 'true'`);
    }
    if (userId) {
      await tx.$executeRawUnsafe(`SET LOCAL app.user_id = '${userId}'`);
    }
    return fn(tx);
  });
}

/**
 * Append an audit row via the SECURITY DEFINER function, bypassing the
 * INSERT-denied RLS policy on audit_log. Always runs outside a caller
 * transaction to avoid holding locks during the slow audit path.
 */
export async function appendAudit(row: {
  id: string;
  ts: Date;
  actorPrincipal: string;
  onBehalfOfUserId?: string;
  source: 'cli' | 'web' | 'api' | 'system';
  requestId?: string;
  ip?: string;
  tenantId?: string;
  scopeUsed: string[];
  action: string;
  resourceType?: string;
  resourceId?: string;
  beforeHash?: string;
  afterHash?: string;
  outcome: 'allow' | 'deny' | 'error';
  details?: unknown;
}): Promise<void> {
  await prisma.$executeRaw`
    SELECT oweibo.append_audit(
      ${row.id}::uuid,
      ${row.ts}::timestamptz,
      ${row.actorPrincipal},
      ${row.onBehalfOfUserId ?? null}::uuid,
      ${row.source},
      ${row.requestId ?? null},
      ${row.ip ?? null},
      ${row.tenantId ?? null}::uuid,
      ${row.scopeUsed}::text[],
      ${row.action},
      ${row.resourceType ?? null},
      ${row.resourceId ?? null},
      ${row.beforeHash ?? null},
      ${row.afterHash ?? null},
      ${row.outcome},
      ${row.details !== undefined ? JSON.stringify(row.details) : null}::jsonb
    )
  `;
}
