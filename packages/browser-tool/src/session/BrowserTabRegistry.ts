/**
 * BrowserTabRegistry — Redis-backed tab state store.
 * In-memory Page references (_pageRef) are held only in BrowserSessionManager.
 * (v9.5.3 M1 — fully specified)
 */

import type { BrowserTabState } from '@oweibo/core-contracts';
import type { Redis } from 'ioredis';

const TAB_TTL_SECONDS = 4 * 60 * 60; // 4 hours

/** Minimal key-builder — avoids raw string templates in application code. */
const K = {
  tab: (tenantId: string, sessionId: string, tabId: string) =>
    `oweibo:browser:${tenantId}:tab:${sessionId}:${tabId}`,
  tabSet: (tenantId: string, sessionId: string) =>
    `oweibo:browser:${tenantId}:tabs:${sessionId}`,
};

export class BrowserTabRegistry {
  constructor(private readonly redis: Redis) {}

  async register(tab: Omit<BrowserTabState, '_pageRef'>): Promise<void> {
    await Promise.all([
      this.redis.set(
        K.tab(tab.tenantId, tab.sessionId, tab.tabId),
        JSON.stringify(tab),
        'EX',
        TAB_TTL_SECONDS,
      ),
      this.redis.sadd(K.tabSet(tab.tenantId, tab.sessionId), tab.tabId),
      this.redis.expire(K.tabSet(tab.tenantId, tab.sessionId), TAB_TTL_SECONDS),
    ]);
  }

  async get(
    tenantId: string,
    sessionId: string,
    tabId: string,
  ): Promise<BrowserTabState | null> {
    const raw = await this.redis.get(K.tab(tenantId, sessionId, tabId));
    return raw ? (JSON.parse(raw) as BrowserTabState) : null;
  }

  async list(tenantId: string, sessionId: string): Promise<BrowserTabState[]> {
    const ids = await this.redis.smembers(K.tabSet(tenantId, sessionId));
    const tabs = await Promise.all(ids.map((id) => this.get(tenantId, sessionId, id)));
    return tabs.filter((t): t is BrowserTabState => t !== null);
  }

  async setActive(tenantId: string, sessionId: string, tabId: string): Promise<void> {
    const all = await this.list(tenantId, sessionId);
    await Promise.all(
      all.map((tab) => this.register({ ...tab, isActive: tab.tabId === tabId })),
    );
  }

  async remove(tenantId: string, sessionId: string, tabId: string): Promise<void> {
    await Promise.all([
      this.redis.del(K.tab(tenantId, sessionId, tabId)),
      this.redis.srem(K.tabSet(tenantId, sessionId), tabId),
    ]);
  }

  async removeAll(tenantId: string, sessionId: string): Promise<void> {
    const all = await this.list(tenantId, sessionId);
    await Promise.all(all.map((t) => this.remove(tenantId, sessionId, t.tabId)));
    await this.redis.del(K.tabSet(tenantId, sessionId));
  }

  async updateUrlAndTitle(
    tenantId: string,
    sessionId: string,
    tabId: string,
    url: string,
    title: string,
  ): Promise<void> {
    const tab = await this.get(tenantId, sessionId, tabId);
    if (!tab) return;
    await this.register({ ...tab, url, title });
  }
}
