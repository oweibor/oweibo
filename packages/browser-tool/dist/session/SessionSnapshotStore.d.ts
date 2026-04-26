/**
 * SessionSnapshotStore — persists browser session storage state (cookies + origins)
 * and tab snapshot metadata to Redis for worker-restart resilience.
 */
import type { Redis } from 'ioredis';
export interface TabSnapshot {
    tabId: string;
    url: string;
    isActive: boolean;
}
export interface SessionSnapshot {
    storageState?: string;
    tabs: TabSnapshot[];
    activeTabId: string;
    activeDeviceDescriptor?: string;
    profileKey?: string;
    profileDir?: string;
}
export declare class SessionSnapshotStore {
    private readonly redis;
    constructor(redis: Redis);
    save(tenantId: string, sessionId: string, snapshot: SessionSnapshot): Promise<void>;
    load(tenantId: string, sessionId: string): Promise<SessionSnapshot | null>;
    delete(tenantId: string, sessionId: string): Promise<void>;
    updateStorageState(tenantId: string, sessionId: string, storageState: string): Promise<void>;
}
//# sourceMappingURL=SessionSnapshotStore.d.ts.map