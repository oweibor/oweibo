/**
 * policies.routes.ts — F.4.4 HTTP surface for the four tenant policy
 * override domains. Mounted at `/api/v1/tenants/:tenantId/actions/policies/*`,
 * cross-checked against the JWT by `requireTenantParamMatchesJwt`.
 *
 *   GET    /actions/policies/:domain                  — list tenant overrides
 *   GET    /actions/policies/:domain/:actionClass     — effective resolved policy
 *   PUT    /actions/policies/:domain/:actionClass     — upsert override
 *   DELETE /actions/policies/:domain/:actionClass     — remove override (revert to default)
 *
 *   …where `:domain` ∈ { sla, multiparty, ratelimit, quota }.
 *
 * Each domain takes a Zod-validated body. Service-layer floor checks
 * throw `PolicyBelowFloorError`, which the handler maps to HTTP 400
 * `policy_below_platform_floor` carrying the violation list. Tenants
 * cannot weaken below the platform floors via this API — documented
 * exception path is support.
 *
 * Quota is the only domain whose key includes (kind, scope, window)
 * instead of (action_class). For consistency with the URL shape:
 *   - The `:actionClass` URL segment IS the quota `scope`.
 *   - Quota body must carry `quotaKind` and `window` explicitly.
 *   - DELETE for quota requires `?kind=…&window=…` query params so a
 *     single :actionClass can have multiple deleteable rows.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../middleware/authenticate.js';
import { requireTenantParamMatchesJwt } from '../middleware/tenantParam.js';
import type { ApprovalSlaService } from '../../action/ApprovalSlaService.js';
import type { MultiPartyApprovalService } from '../../action/MultiPartyApprovalService.js';
import type { RateLimitPolicyResolver } from '../../action/RateLimitPolicy.js';
import type { QuotaService } from '../../action/QuotaService.js';
import type {
  ActionClass,
  ApprovalSlaPolicy,
  MultiPartyApprovalPolicy,
  NotificationChannelRef,
  QuotaKind,
  QuotaPolicy,
  QuotaWindow,
  RateLimitPolicy,
} from '@oweibo/core-contracts';
import { PolicyBelowFloorError } from '../../action/PolicyFloor.js';

// ── Zod schemas ─────────────────────────────────────────────────────────

const SlaBody = z.object({
  initialNotifyAfterSeconds: z.number().int().min(0),
  escalateAfterSeconds: z.array(z.number().int().min(0)).max(20),
  hardExpireAfterSeconds: z.number().int().positive(),
  approverResolution: z.enum(['org_graph', 'role_based', 'explicit_list']),
  approverConfig: z.unknown().optional(),
  notificationChannels: z.array(z.unknown()).optional(),
  quietHours: z.unknown().optional(),
});

const MultiPartyBody = z.object({
  quorum: z.number().int().min(1).max(10),
  dissentVetoes: z.boolean(),
  allowGrants: z.boolean(),
  maxGrantDurationSeconds: z.number().int().positive(),
  maxGrantActionCount: z.number().int().positive(),
  allowDelegation: z.boolean(),
});

const RateLimitBody = z.object({
  perMinute: z.number().int().min(0),
  perHour: z.number().int().min(0),
  perDay: z.number().int().min(0),
  burstAllowance: z.number().int().min(0),
  coldStartMultiplier: z.number().min(0.05).max(1.0),
  coldStartDurationDays: z.number().int().min(0),
  enforcementMode: z.string().min(1),
});

const QuotaBody = z.object({
  quotaKind: z.enum([
    'action_count_per_class',
    'usd_cost_per_class',
    'usd_cost_total',
    'total_actions',
    'blast_radius_user_count',
  ]),
  window: z.enum(['day', 'month', 'year']),
  limitValue: z.number().int(),
  coldStartLimit: z.number().int().positive().nullish(),
  coldStartDurationDays: z.number().int().min(0),
  enforcementMode: z.string().min(1),
});

const QuotaDeleteQuery = z.object({
  kind: z.enum([
    'action_count_per_class',
    'usd_cost_per_class',
    'usd_cost_total',
    'total_actions',
    'blast_radius_user_count',
  ]),
  window: z.enum(['day', 'month', 'year']),
});

const POLICY_DOMAINS = ['sla', 'multiparty', 'ratelimit', 'quota'] as const;
type PolicyDomain = (typeof POLICY_DOMAINS)[number];

// ── Router ───────────────────────────────────────────────────────────────

export interface PoliciesRouterDeps {
  readonly sla: ApprovalSlaService;
  readonly multiparty: MultiPartyApprovalService;
  readonly ratelimit: RateLimitPolicyResolver;
  readonly quota: QuotaService;
}

export function createPoliciesRouter(deps: PoliciesRouterDeps): Router {
  const router = Router({ mergeParams: true });
  router.use(requireTenantParamMatchesJwt as unknown as import('express').RequestHandler);

  // ── List overrides ────────────────────────────────────────────────────

  router.get('/:domain', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const domain = (req.params['domain'] ?? '') as PolicyDomain;
    if (!POLICY_DOMAINS.includes(domain)) {
      res.status(404).json({ error: 'not_found', message: `unknown policy domain: ${domain}` });
      return;
    }
    try {
      const rows = await dispatchList(deps, domain, r.tenantId);
      res.json({ domain, policies: rows, count: rows.length });
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── Effective (resolved) policy ───────────────────────────────────────

  router.get('/:domain/:actionClass', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const domain = (req.params['domain'] ?? '') as PolicyDomain;
    const actionClass = req.params['actionClass'] ?? '';
    if (!POLICY_DOMAINS.includes(domain)) {
      res.status(404).json({ error: 'not_found', message: `unknown policy domain: ${domain}` });
      return;
    }
    try {
      const effective = await dispatchEffective(deps, domain, r.tenantId, actionClass);
      res.json({ domain, actionClass, effective });
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── Upsert (write) ────────────────────────────────────────────────────

  router.put('/:domain/:actionClass', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const domain = (req.params['domain'] ?? '') as PolicyDomain;
    const actionClass = req.params['actionClass'] ?? '';
    if (!POLICY_DOMAINS.includes(domain)) {
      res.status(404).json({ error: 'not_found', message: `unknown policy domain: ${domain}` });
      return;
    }
    try {
      const policy = await dispatchUpsert(deps, domain, r.tenantId, actionClass, req.body, r.userId);
      res.json({ domain, actionClass, policy });
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── Delete (revert to platform default) ───────────────────────────────

  router.delete('/:domain/:actionClass', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const domain = (req.params['domain'] ?? '') as PolicyDomain;
    const actionClass = req.params['actionClass'] ?? '';
    if (!POLICY_DOMAINS.includes(domain)) {
      res.status(404).json({ error: 'not_found', message: `unknown policy domain: ${domain}` });
      return;
    }
    try {
      const deleted = await dispatchDelete(deps, domain, r.tenantId, actionClass, req.query);
      if (!deleted) {
        res.status(404).json({ error: 'not_found', message: 'no override to delete' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

// ── Dispatchers ──────────────────────────────────────────────────────────

async function dispatchList(
  deps: PoliciesRouterDeps,
  domain: PolicyDomain,
  tenantId: string,
): Promise<readonly unknown[]> {
  switch (domain) {
    case 'sla':        return deps.sla.listPolicies(tenantId);
    case 'multiparty': return deps.multiparty.listPolicies(tenantId);
    case 'ratelimit':  return deps.ratelimit.listPolicies(tenantId);
    case 'quota':      return deps.quota.listPolicies(tenantId);
  }
}

async function dispatchEffective(
  deps: PoliciesRouterDeps,
  domain: PolicyDomain,
  tenantId: string,
  actionClass: string,
): Promise<unknown> {
  switch (domain) {
    case 'sla':        return deps.sla.resolvePolicy(tenantId, actionClass);
    case 'multiparty': return deps.multiparty.resolvePolicy(tenantId, actionClass as ActionClass);
    case 'ratelimit':  return deps.ratelimit.resolve(tenantId, actionClass);
    case 'quota':
      // Quotas resolve by matching kinds/windows — surface the full
      // tenant rows for this scope; admin UI computes the effective
      // per (kind, window) on the client.
      return (await deps.quota.listPolicies(tenantId)).filter(
        (p) => p.scope === actionClass || p.scope === '*',
      );
  }
}

async function dispatchUpsert(
  deps: PoliciesRouterDeps,
  domain: PolicyDomain,
  tenantId: string,
  actionClass: string,
  body: unknown,
  userId: string,
): Promise<unknown> {
  switch (domain) {
    case 'sla': {
      const parsed = SlaBody.safeParse(body);
      if (!parsed.success) throw new ZodFail(parsed.error.issues);
      const policy: Omit<ApprovalSlaPolicy, 'tenantId' | 'actionClass'> = {
        initialNotifyAfterSeconds: parsed.data.initialNotifyAfterSeconds,
        escalateAfterSeconds: parsed.data.escalateAfterSeconds,
        hardExpireAfterSeconds: parsed.data.hardExpireAfterSeconds,
        approverResolution: parsed.data.approverResolution,
        approverConfig: parsed.data.approverConfig ?? {},
        notificationChannels: (parsed.data.notificationChannels ?? []) as readonly NotificationChannelRef[],
        ...(parsed.data.quietHours !== undefined
          ? { quietHours: parsed.data.quietHours as ApprovalSlaPolicy['quietHours'] }
          : {}),
      };
      return deps.sla.upsertPolicy(tenantId, actionClass, policy, { createdBy: userId });
    }
    case 'multiparty': {
      const parsed = MultiPartyBody.safeParse(body);
      if (!parsed.success) throw new ZodFail(parsed.error.issues);
      const policy: Omit<MultiPartyApprovalPolicy, 'tenantId' | 'actionClass'> = {
        quorum: parsed.data.quorum,
        dissentVetoes: parsed.data.dissentVetoes,
        allowGrants: parsed.data.allowGrants,
        maxGrantDurationSeconds: parsed.data.maxGrantDurationSeconds,
        maxGrantActionCount: parsed.data.maxGrantActionCount,
        allowDelegation: parsed.data.allowDelegation,
      };
      return deps.multiparty.upsertPolicy(tenantId, actionClass, policy);
    }
    case 'ratelimit': {
      const parsed = RateLimitBody.safeParse(body);
      if (!parsed.success) throw new ZodFail(parsed.error.issues);
      const policy: Omit<RateLimitPolicy, 'tenantId' | 'actionClass'> = {
        perMinute: parsed.data.perMinute,
        perHour: parsed.data.perHour,
        perDay: parsed.data.perDay,
        burstAllowance: parsed.data.burstAllowance,
        coldStartMultiplier: parsed.data.coldStartMultiplier,
        coldStartDurationDays: parsed.data.coldStartDurationDays,
        enforcementMode: parsed.data.enforcementMode as RateLimitPolicy['enforcementMode'],
      };
      return deps.ratelimit.upsertPolicy(tenantId, actionClass, policy);
    }
    case 'quota': {
      const parsed = QuotaBody.safeParse(body);
      if (!parsed.success) throw new ZodFail(parsed.error.issues);
      const policy: Omit<QuotaPolicy, 'tenantId'> = {
        quotaKind: parsed.data.quotaKind as QuotaKind,
        scope: actionClass as ActionClass | '*',
        window: parsed.data.window as QuotaWindow,
        limitValue: parsed.data.limitValue,
        ...(parsed.data.coldStartLimit !== null && parsed.data.coldStartLimit !== undefined
          ? { coldStartLimit: parsed.data.coldStartLimit }
          : {}),
        coldStartDurationDays: parsed.data.coldStartDurationDays,
        enforcementMode: parsed.data.enforcementMode as QuotaPolicy['enforcementMode'],
      };
      return deps.quota.upsertPolicy(tenantId, policy);
    }
  }
}

async function dispatchDelete(
  deps: PoliciesRouterDeps,
  domain: PolicyDomain,
  tenantId: string,
  actionClass: string,
  query: unknown,
): Promise<boolean> {
  switch (domain) {
    case 'sla':        return deps.sla.deletePolicy(tenantId, actionClass);
    case 'multiparty': return deps.multiparty.deletePolicy(tenantId, actionClass);
    case 'ratelimit':  return deps.ratelimit.deletePolicy(tenantId, actionClass);
    case 'quota': {
      const parsed = QuotaDeleteQuery.safeParse(query);
      if (!parsed.success) throw new ZodFail(parsed.error.issues);
      return deps.quota.deletePolicy(tenantId, {
        quotaKind: parsed.data.kind as QuotaKind,
        scope: actionClass,
        window: parsed.data.window as QuotaWindow,
      });
    }
  }
}

// ── Errors ───────────────────────────────────────────────────────────────

class ZodFail extends Error {
  constructor(public readonly issues: unknown) {
    super('invalid_request');
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function handleError(err: unknown, res: Response): void {
  if (err instanceof ZodFail) {
    res.status(400).json({ error: 'invalid_request', issues: err.issues });
    return;
  }
  if (err instanceof PolicyBelowFloorError) {
    res.status(400).json({
      error: err.code,
      message: err.message,
      domain: err.policyDomain,
      actionClass: err.actionClass,
      violations: err.violations,
    });
    return;
  }
  const message = err instanceof Error ? err.message : 'internal_error';
  if (/not found/i.test(message)) {
    res.status(404).json({ error: 'not_found', message });
    return;
  }
  res.status(500).json({ error: 'internal_error', message });
}
