/**
 * Unit tests for quota service.
 * Uses an in-memory Redis mock — no live Redis connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

function makeRedis(store: Record<string, string> = {}) {
    return {
        get:    vi.fn(async (k: string) => store[k] ?? null),
        incr:   vi.fn(async (k: string) => { store[k] = String((parseInt(store[k] ?? '0', 10)) + 1); return parseInt(store[k], 10); }),
        incrby: vi.fn(async (k: string, n: number) => { store[k] = String((parseInt(store[k] ?? '0', 10)) + n); return parseInt(store[k], 10); }),
        expire: vi.fn(async () => 1),
    };
}

// We import quota as a module that we initialize with a redis mock.
// The module caches a `redis` closure variable so we need to use
// dynamic import after setting up mocks each time.

describe('quota service', () => {
    it('consume returns 1 on first call', async () => {
        const store: Record<string, string> = {};
        const redis = makeRedis(store);
        const { initQuota, consume } = await import('../quota.js');
        initQuota(redis as any);
        const result = await consume('tenant-1', 'tasks_day');
        expect(result).toBe(1);
    });

    it('isAllowed returns false when at cap', async () => {
        const store: Record<string, string> = {};
        const today = new Date().toISOString().slice(0, 10);
        store[`quota:tenant-2:tasks_day:${today}`] = '50';
        const redis = makeRedis(store);
        const { initQuota, isAllowed } = await import('../quota.js');
        initQuota(redis as any);
        const allowed = await isAllowed('tenant-2', 'tasks_day', 50);
        expect(allowed).toBe(false);
    });

    it('isAllowed returns true when below cap', async () => {
        const store: Record<string, string> = {};
        const today = new Date().toISOString().slice(0, 10);
        store[`quota:tenant-3:tasks_day:${today}`] = '3';
        const redis = makeRedis(store);
        const { initQuota, isAllowed } = await import('../quota.js');
        initQuota(redis as any);
        const allowed = await isAllowed('tenant-3', 'tasks_day', 50);
        expect(allowed).toBe(true);
    });

    it('checkAndConsume increments and checks cap', async () => {
        const store: Record<string, string> = {};
        const today = new Date().toISOString().slice(0, 10);
        store[`quota:tenant-4:scrapes_day:${today}`] = '9';
        const redis = makeRedis(store);
        const { initQuota, checkAndConsume } = await import('../quota.js');
        initQuota(redis as any);
        const { allowed, current } = await checkAndConsume('tenant-4', 'scrapes_day', 1, 10);
        expect(current).toBe(10);
        expect(allowed).toBe(true);

        const next = await checkAndConsume('tenant-4', 'scrapes_day', 1, 10);
        expect(next.current).toBe(11);
        expect(next.allowed).toBe(false);
    });

    it('fails open when redis is unavailable', async () => {
        const badRedis = {
            get:    vi.fn(async () => { throw new Error('connection refused'); }),
            incr:   vi.fn(async () => { throw new Error('connection refused'); }),
            incrby: vi.fn(async () => { throw new Error('connection refused'); }),
            expire: vi.fn(async () => { throw new Error('connection refused'); }),
        };
        const { initQuota, isAllowed, consume } = await import('../quota.js');
        initQuota(badRedis as any);
        await expect(isAllowed('t', 'tasks_day')).resolves.toBe(true);
        await expect(consume('t', 'tasks_day')).resolves.toBe(0);
    });
});
