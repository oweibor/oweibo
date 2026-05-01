/**
 * Redis-backed per-tenant quota service.
 *
 * Quotas reset at UTC midnight (daily rolling window keyed by date).
 * Each counter is a Redis key with a 25-hour TTL so keys expire shortly
 * after the daily reset — no background cleanup needed.
 *
 * Supported quota kinds:
 *   tasks      — tasks submitted (hard cap = tenants.quotas.maxConcurrentTasks tracked live by queue)
 *   tasks_day  — tasks submitted in the current day (default: 50 free)
 *   tokens_day — LLM tokens consumed today (default: 1_000_000 free)
 *   scrapes_day — scrape jobs started today (default: 10 free)
 *   agent_min_day — agent-run minutes today (default: 60 free)
 *
 * @module services/quota
 */

const logger = require('./logger');

type QuotaKind = 'tasks_day' | 'tokens_day' | 'scrapes_day' | 'agent_min_day';

// Default caps per kind — override via tenants.quotas in DB (future)
const DEFAULT_CAPS: Record<QuotaKind, number> = {
    tasks_day:     50,
    tokens_day:    1_000_000,
    scrapes_day:   10,
    agent_min_day: 60,
};

// TTL slightly longer than a day so we don't expire mid-day on clock skew
const TTL_SECONDS = 25 * 60 * 60;

interface RedisLike {
    get(key: string): Promise<string | null>;
    incr(key: string): Promise<number>;
    incrby(key: string, n: number): Promise<number>;
    expire(key: string, seconds: number): Promise<number | boolean>;
}

let redis: RedisLike | null = null;

export function initQuota(redisClient: RedisLike): void {
    redis = redisClient;
    logger.info('[quota] service initialised');
}

function dailyKey(tenantId: string, kind: QuotaKind): string {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return `quota:${tenantId}:${kind}:${date}`;
}

/**
 * Increment a quota counter by `amount` and return the new total.
 * Returns the new value even when Redis is unavailable (fails open — quota
 * is best-effort in v1; hard enforcement adds a Redis-circuit-breaker in Phase 7).
 */
export async function consume(tenantId: string, kind: QuotaKind, amount = 1): Promise<number> {
    if (!redis) return 0;
    const key = dailyKey(tenantId, kind);
    try {
        const next = amount === 1
            ? await redis.incr(key)
            : await redis.incrby(key, amount);
        await redis.expire(key, TTL_SECONDS);
        return next;
    } catch (err: any) {
        logger.warn('[quota] redis error — failing open', { kind, tenantId, error: err.message });
        return 0;
    }
}

/**
 * Check whether the tenant is within quota for the given kind.
 * Cap is resolved from DEFAULT_CAPS; future version reads from tenants.quotas.
 *
 * Returns true (allowed) if Redis is unavailable — fails open in v1.
 */
export async function isAllowed(tenantId: string, kind: QuotaKind, cap?: number): Promise<boolean> {
    if (!redis) return true;
    const key    = dailyKey(tenantId, kind);
    const limit  = cap ?? DEFAULT_CAPS[kind];
    try {
        const raw = await redis.get(key);
        const current = raw ? parseInt(raw, 10) : 0;
        return current < limit;
    } catch (err: any) {
        logger.warn('[quota] redis error on isAllowed — failing open', { kind, tenantId, error: err.message });
        return true;
    }
}

/**
 * Consume a unit and check if the resulting count exceeds the cap.
 * Returns `{ allowed: boolean, current: number }`.
 */
export async function checkAndConsume(
    tenantId: string,
    kind: QuotaKind,
    amount = 1,
    cap?: number,
): Promise<{ allowed: boolean; current: number }> {
    const current = await consume(tenantId, kind, amount);
    const limit   = cap ?? DEFAULT_CAPS[kind];
    return { allowed: current <= limit, current };
}

/**
 * Return current usage for all quota kinds for a tenant.
 */
export async function getUsage(tenantId: string): Promise<Record<QuotaKind, number>> {
    const kinds: QuotaKind[] = ['tasks_day', 'tokens_day', 'scrapes_day', 'agent_min_day'];
    const result = {} as Record<QuotaKind, number>;

    if (!redis) {
        for (const k of kinds) result[k] = 0;
        return result;
    }

    await Promise.all(kinds.map(async (k) => {
        try {
            const raw = await redis!.get(dailyKey(tenantId, k));
            result[k] = raw ? parseInt(raw, 10) : 0;
        } catch {
            result[k] = 0;
        }
    }));

    return result;
}
