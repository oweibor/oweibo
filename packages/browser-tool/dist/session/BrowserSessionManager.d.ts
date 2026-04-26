/**
 * BrowserSessionManager — singleton per process, manages all browser sessions.
 *
 * Handles session lifecycle: create, execute action, snapshot, restore, destroy.
 * Enforces tenant isolation, concurrency limits, and integrates all subsystems.
 */
import type { Redis } from 'ioredis';
import type { BrowserAction, BrowserActionResult, BrowserSession, BrowserSessionConfig, BrowserTabState, IBrowserEventEmitter, IBrowserExecutionContext, IProfileStore } from '@oweibo/core-contracts';
import { BrowserTabRegistry } from './BrowserTabRegistry.js';
import { SessionSnapshotStore } from './SessionSnapshotStore.js';
import { DialogManager } from './DialogManager.js';
import { NetworkInterceptRegistry } from './NetworkInterceptRegistry.js';
import { BrowserLogCollector } from './BrowserLogCollector.js';
import { BrowserDlpFilter } from './BrowserDlpFilter.js';
import { BrowserExtensionRegistry } from './BrowserExtensionRegistry.js';
import { ScreenshotWatermarker } from './ScreenshotWatermarker.js';
import { BrowserCredentialStore } from './BrowserCredentialStore.js';
import { DomainReputationStore } from './DomainReputationStore.js';
import type { ExtensionBridgeServer } from './ExtensionBridgeServer.js';
import type { StealthProfilePool } from '../stealth/StealthProfilePool.js';
import type { IBrowserBackend } from '../contracts/IBrowserBackend.js';
import type { BrowserSessionRouter } from './BrowserSessionRouter.js';
import type { ILogger } from './SessionReaper.js';
export interface FrameRef {
    frameId: string;
    type: 'css';
    selector: string;
}
interface CreateSessionOptions {
    headful?: boolean;
    shareToken?: string;
    credentialRef?: string;
    persistentProfileId?: string;
    useStealthPool?: boolean;
    /** Passed to BrowserSessionRouter when backend==='auto'. */
    taskHint?: 'research' | 'checkout' | 'auth' | 'form';
}
interface IVaultClient {
    read(path: string): Promise<unknown>;
    readOptional(path: string): Promise<unknown>;
    write(path: string, value: unknown): Promise<void>;
}
interface IBrowserSandboxConfig {
    uploadDir(tenantId: string): string;
    downloadDir(tenantId: string): string;
    videoDir(tenantId: string): string;
    harDir(tenantId: string): string;
    pdfDir(tenantId: string): string;
    profileDir(tenantId: string, sessionId: string): string;
}
export declare class BrowserSessionManager {
    private readonly redis;
    private readonly vault;
    private readonly logger;
    private readonly sandboxConfig;
    private readonly profileStore;
    private readonly stealthPool;
    private readonly extensionBridge;
    private readonly backendRouter;
    private readonly globalMaxSessions;
    private readonly maxSessionsPerTenant;
    private readonly sessionRouter;
    private readonly contextPool;
    private readonly frameStacks;
    readonly tabRegistry: BrowserTabRegistry;
    readonly snapshotStore: SessionSnapshotStore;
    readonly dialogManager: DialogManager;
    readonly interceptRegistry: NetworkInterceptRegistry;
    readonly logCollector: BrowserLogCollector;
    readonly dlpFilter: BrowserDlpFilter;
    readonly extensionRegistry: BrowserExtensionRegistry;
    readonly watermarker: ScreenshotWatermarker;
    readonly credentialStore: BrowserCredentialStore;
    readonly domainReputation: DomainReputationStore;
    constructor(redis: Redis, vault: IVaultClient, logger: ILogger, sandboxConfig: IBrowserSandboxConfig, profileStore: IProfileStore | null, stealthPool: StealthProfilePool | null, extensionBridge: ExtensionBridgeServer | null, backendRouter: {
        route(tenantId: string, backend: string, hostname?: string): Promise<IBrowserBackend>;
    }, globalMaxSessions: number, maxSessionsPerTenant: number, sessionRouter?: BrowserSessionRouter | null);
    createSession(tenantId: string, sessionId: string, taskId: string, config: BrowserSessionConfig, securityContext: IBrowserExecutionContext['securityContext'], emitter: IBrowserEventEmitter, options?: CreateSessionOptions): Promise<BrowserSession>;
    executeAction(action: BrowserAction, context: IBrowserExecutionContext): Promise<BrowserActionResult>;
    destroySession(tenantId: string, sessionId: string): Promise<void>;
    pushFrame(tenantId: string, sessionId: string, tabId: string, frame: FrameRef): void;
    popFrame(tenantId: string, sessionId: string, tabId: string): void;
    clearFrameStack(tenantId: string, sessionId: string, tabId: string): void;
    clearAllFrameStacks(tenantId: string, sessionId: string): void;
    getFrameStack(tenantId: string, sessionId: string, tabId: string): FrameRef[];
    private readonly pageRefs;
    setPageRef(tenantId: string, sessionId: string, tabId: string, page: any): void;
    getPageRef(tenantId: string, sessionId: string, tabId: string): any | undefined;
    getContext(tenantId: string, sessionId: string): any;
    getActiveTabId(tenantId: string, sessionId: string): Promise<string>;
    setActiveTabId(tenantId: string, sessionId: string, tabId: string): Promise<void>;
    getBackend(tenantId: string, sessionId: string): Promise<string>;
    listTabs(tenantId: string, sessionId: string): Promise<BrowserTabState[]>;
    snapshotSession(tenantId: string, sessionId: string): Promise<void>;
    private createPersistentSession;
    private acquireSharedSession;
    private restoreSession;
    private getSession;
    private persistSession;
    private updateLastActivity;
    private poolKey;
    private frameKey;
}
/**
 * Resolve a selector to a Locator, respecting the current frame stack.
 */
export declare function resolveLocator(page: any, selector: string, frameStack: FrameRef[]): any;
export {};
//# sourceMappingURL=BrowserSessionManager.d.ts.map