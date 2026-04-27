import { prisma } from './client.js';
import type { Principal, PrismaTx } from './types.js';

/**
 * The single entry point for all oweibo.* database queries.
 *
 * Sets Postgres session parameters before running the callback:
 *   app.tenant_id        — activates the tenant_isolation RLS policy
 *   app.is_platform_admin — activates the platform_admin_bypass RLS policy
 *   app.user_id          — activates the self_read policy on oweibo.users
 *
 * All three are SET LOCAL (transaction-scoped), so they don't leak across
 * connections when using PgBouncer in transaction-pool mode.
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
