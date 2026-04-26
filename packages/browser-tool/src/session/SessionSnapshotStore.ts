/**
 * SessionSnapshotStore — persists browser session storage state (cookies + origins)
 * and tab snapshot metadata to Redis for worker-restart resilience.
 */

import type { Redis } from 'ioredis';

const SNAPSHOT_TTL_SECONDS = 6 * 60 * 60; // 6 hours

export interface TabSnapshot {
  tabId: string;
  url: string;
  isActive: boolean;
}

export interface SessionSnapshot {
  storageState?: string;         // base64 Playwright storageState JSON
  tabs: TabSnapshot[];
  activeTabId: string;
  activeDeviceDescriptor?: string; // serialised BrowserDeviceDescriptor JSON
  profileKey?: string;             // for persistent backend
  profileDir?: string;             // temp dir for persistent backend
}

const K = {
  snapshot: (tenantId: string, sessionId: string) =>
    `oweibo:${tenantId}:browser-snapshot:${sessionId}`,
};

export class SessionSnapshotStore {
  constructor(private readonly redis: Redis) {}

  async save(
    tenantId: string,
    sessionId: string,
    snapshot: SessionSnapshot,
  ): Promise<void> {
    await this.redis.set(
      K.snapshot(tenantId, sessionId),
      JSON.stringify(snapshot),
      'EX',
      SNAPSHOT_TTL_SECONDS,
    );
  }

  async load(
    tenantId: string,
    sessionId: string,
  ): Promise<SessionSnapshot | null> {
    const raw = await this.redis.get(K.snapshot(tenantId, sessionId));
    return raw ? (JSON.parse(raw) as SessionSnapshot) : null;
  }

  async delete(tenantId: string, sessionId: string): Promise<void> {
    await this.redis.del(K.snapshot(tenantId, sessionId));
  }

  async updateStorageState(
    tenantId: string,
    sessionId: string,
    storageState: string,
  ): Promise<void> {
    const existing = await this.load(tenantId, sessionId);
    if (!existing) return;
    await this.save(tenantId, sessionId, { ...existing, storageState });
  }
}
