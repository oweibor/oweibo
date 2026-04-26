/**
 * BrowserTabRegistry — Redis-backed tab state store.
 * In-memory Page references (_pageRef) are held only in BrowserSessionManager.
 * (v9.5.3 M1 — fully specified)
 */
import type { BrowserTabState } from '@oweibo/core-contracts';
import type { Redis } from 'ioredis';
export declare class BrowserTabRegistry {
    private readonly redis;
    constructor(redis: Redis);
    register(tab: Omit<BrowserTabState, '_pageRef'>): Promise<void>;
    get(tenantId: string, sessionId: string, tabId: string): Promise<BrowserTabState | null>;
    list(tenantId: string, sessionId: string): Promise<BrowserTabState[]>;
    setActive(tenantId: string, sessionId: string, tabId: string): Promise<void>;
    remove(tenantId: string, sessionId: string, tabId: string): Promise<void>;
    removeAll(tenantId: string, sessionId: string): Promise<void>;
    updateUrlAndTitle(tenantId: string, sessionId: string, tabId: string, url: string, title: string): Promise<void>;
}
//# sourceMappingURL=BrowserTabRegistry.d.ts.map