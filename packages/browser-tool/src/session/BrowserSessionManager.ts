/**
 * BrowserSessionManager — singleton per process, manages all browser sessions.
 *
 * Handles session lifecycle: create, execute action, snapshot, restore, destroy.
 * Enforces tenant isolation, concurrency limits, and integrates all subsystems.
 */

import * as crypto from 'crypto';
import type { Redis } from 'ioredis';
import type {
  BrowserAction,
  BrowserActionResult,
  BrowserSession,
  BrowserSessionConfig,
  BrowserTabState,
  IBrowserEventEmitter,
  IBrowserExecutionContext,
  IProfileStore,
} from '@oweibo/core-contracts';

import { BrowserTabRegistry } from './BrowserTabRegistry.js';
import { SessionSnapshotStore, type SessionSnapshot } from './SessionSnapshotStore.js';
import { DialogManager } from './DialogManager.js';
import { DialogAutoPolicy } from './DialogAutoPolicy.js';
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

import {
  BrowserPolicyViolationError,
  BrowserSessionLimitError,
  BrowserSessionNotFoundError,
  BrowserTenantViolationError,
  BrowserLastTabError,
} from '../contracts/errors.js';
import type { ILogger } from './SessionReaper.js';

export interface FrameRef {
  frameId: string;
  type: 'css';
  selector: string;
}

interface SessionEntry {
  session: BrowserSession;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any; // Playwright BrowserContext
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

const SESSION_TTL_SECONDS = 4 * 60 * 60; // 4 hours
const INFLIGHT_TTL_SECONDS = 60;

const K = {
  session: (tenantId: string, sessionId: string) =>
    `oweibo:browser:${tenantId}:session:${sessionId}`,
  inflight: (tenantId: string, sessionId: string) =>
    `oweibo:${tenantId}:browser-inflight:${sessionId}`,
};

export class BrowserSessionManager {
  // Core state
  private readonly contextPool = new Map<string, SessionEntry>();
  // In-memory frame stacks: key = `${tenantId}:${sessionId}:${tabId}`
  private readonly frameStacks = new Map<string, FrameRef[]>();

  // Subsystems
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

  constructor(
    private readonly redis: Redis,
    private readonly vault: IVaultClient,
    private readonly logger: ILogger,
    private readonly sandboxConfig: IBrowserSandboxConfig,
    private readonly profileStore: IProfileStore | null,
    private readonly stealthPool: StealthProfilePool | null,
    private readonly extensionBridge: ExtensionBridgeServer | null,
    private readonly backendRouter: {
      route(tenantId: string, backend: string, hostname?: string): Promise<IBrowserBackend>;
    },
    private readonly globalMaxSessions: number,
    private readonly maxSessionsPerTenant: number,
    private readonly sessionRouter: BrowserSessionRouter | null = null,
  ) {
    this.tabRegistry = new BrowserTabRegistry(redis);
    this.snapshotStore = new SessionSnapshotStore(redis);
    this.dialogManager = new DialogManager();
    this.interceptRegistry = new NetworkInterceptRegistry();
    this.logCollector = new BrowserLogCollector();
    this.dlpFilter = new BrowserDlpFilter(vault);
    this.extensionRegistry = new BrowserExtensionRegistry(vault, logger);
    this.watermarker = new ScreenshotWatermarker(vault, logger);
    this.credentialStore = new BrowserCredentialStore(vault, logger);
    this.domainReputation = new DomainReputationStore(vault, redis, logger);
  }

  // ─── Session Lifecycle ───────────────────────────────────────────────────────

  async createSession(
    tenantId: string,
    sessionId: string,
    taskId: string,
    config: BrowserSessionConfig,
    securityContext: IBrowserExecutionContext['securityContext'],
    emitter: IBrowserEventEmitter,
    options: CreateSessionOptions = {},
  ): Promise<BrowserSession> {
    // Concurrency guards
    if (this.contextPool.size >= this.globalMaxSessions) {
      throw new BrowserSessionLimitError(
        `Global session limit (${this.globalMaxSessions}) reached.`,
      );
    }
    const tenantCount = [...this.contextPool.values()].filter(
      (e) => e.session.tenantId === tenantId,
    ).length;
    if (tenantCount >= this.maxSessionsPerTenant) {
      throw new BrowserSessionLimitError(
        `Per-tenant session limit (${this.maxSessionsPerTenant}) reached for tenant "${tenantId}".`,
      );
    }

    // Share token — reuse existing session
    if (options.shareToken) {
      return this.acquireSharedSession(options.shareToken, tenantId);
    }

    // Auto backend — consult BrowserSessionRouter to pick the optimal backend
    if (config.backend === 'auto') {
      if (this.sessionRouter) {
        try {
          const routingCtx = await this.sessionRouter.buildContext({
            tenantId,
            targetUrl: (config as { initialUrl?: string }).initialUrl ?? '',
            securityContext,
            taskHint: (options as { taskHint?: 'research' | 'checkout' | 'auth' | 'form' }).taskHint,
          });
          const decision = await this.sessionRouter.selectBackend(routingCtx);
          config = { ...config, backend: decision.backend } as BrowserSessionConfig;
          if (decision.useStealthPool) {
            options = { ...options, useStealthPool: true };
          }
          emitter.emit('browser-backend-auto-selected' as never, {
            tenantId,
            sessionId,
            selected: decision.backend,
            reason: decision.reason,
            useStealthPool: decision.useStealthPool,
          });
        } catch (err) {
          this.logger.warn({ err, tenantId }, 'BrowserSessionRouter.selectBackend failed; falling back to local');
          config = { ...config, backend: 'local' } as BrowserSessionConfig;
        }
      } else {
        // No router configured — safe fallback
        config = { ...config, backend: 'local' } as BrowserSessionConfig;
      }
    }

    // Extension backend
    if (config.backend === 'extension') {
      if (!securityContext.allowExtensionBridge) {
        throw new BrowserPolicyViolationError(
          'Extension backend requires allowExtensionBridge trust gate.',
        );
      }
      if (!this.extensionBridge) {
        throw new BrowserPolicyViolationError('ExtensionBridgeServer not configured.');
      }
      const pairingCode = this.extensionBridge.generatePairingCode(sessionId);
      emitter.emit('browser-extension-pairing-required', {
        sessionId,
        tenantId,
        pairingCode,
        instructions: `Open the Oweibo extension and enter: ${pairingCode}`,
      });
      const conn = await this.extensionBridge.awaitPairedConnection(tenantId, sessionId);
      emitter.emit('browser-extension-connected', {
        sessionId,
        tenantId,
        tabId: conn.tabId,
      });
      // Register a synthetic tab
      const tabId = crypto.randomUUID();
      await this.tabRegistry.register({
        tabId,
        sessionId,
        tenantId,
        url: 'chrome://newtab',
        title: 'Connected Tab',
        isActive: true,
      });
      const session: BrowserSession = {
        sessionId,
        tenantId,
        taskId,
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        activeTabId: tabId,
        backend: 'extension',
        status: 'active',
      };
      await this.persistSession(session);
      // Extension backend has no Playwright context — store a sentinel
      this.contextPool.set(this.poolKey(tenantId, sessionId), {
        session,
        context: null,
      });
      emitter.emit('browser-session-created', { sessionId, tenantId, backend: 'extension' });
      return session;
    }

    // Persistent profile backend
    if (config.backend === 'persistent') {
      if (!securityContext.allowPersistentProfile) {
        throw new BrowserPolicyViolationError(
          'Persistent profile backend requires allowPersistentProfile trust gate.',
        );
      }
      return this.createPersistentSession(
        tenantId, sessionId, taskId, config, securityContext, emitter, options,
      );
    }

    // UserChrome CDP backend
    if (config.backend === 'userchrome') {
      if (!securityContext.allowUserChrome) {
        throw new BrowserPolicyViolationError(
          'UserChrome backend requires allowUserChrome trust gate.',
        );
      }
    }

    // Standard backend launch
    const backend = await this.backendRouter.route(tenantId, config.backend);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const context: any = await backend.launchContext(config);

    // Attach subsystems
    const policy = DialogAutoPolicy.forAutonomous();
    this.dialogManager.attachToContext(context, sessionId, tenantId, taskId, emitter, policy);

    // Open initial page
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page: any = await context.newPage();
    const tabId = crypto.randomUUID();
    this.logCollector.attachToPage(page, sessionId, emitter);

    await this.tabRegistry.register({
      tabId,
      sessionId,
      tenantId,
      url: page.url() || 'about:blank',
      title: await page.title().catch(() => ''),
      isActive: true,
    });

    const session: BrowserSession = {
      sessionId,
      tenantId,
      taskId,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      activeTabId: tabId,
      // config.backend is always resolved from 'auto' before reaching here
      backend: config.backend as Exclude<BrowserSessionConfig['backend'], 'auto'>,
      status: 'active',
    };

    // Store page ref in tab state (in-memory only)
    const entry: SessionEntry = { session, context };
    this.contextPool.set(this.poolKey(tenantId, sessionId), entry);
    // Store page ref mapping
    this.setPageRef(tenantId, sessionId, tabId, page);

    if (options.credentialRef) {
      // Pre-verify credential exists (throws if not found)
      await this.credentialStore.fetch(options.credentialRef, tenantId);
    }

    await this.persistSession(session);
    await this.snapshotStore.save(tenantId, sessionId, {
      tabs: [{ tabId, url: page.url() || 'about:blank', isActive: true }],
      activeTabId: tabId,
    });

    emitter.emit('browser-session-created', { sessionId, tenantId, backend: config.backend });
    return session;
  }

  async executeAction(
    action: BrowserAction,
    context: IBrowserExecutionContext,
  ): Promise<BrowserActionResult> {
    const { tenantId, sessionId } = context;

    // Migration guard
    const session = await this.getSession(tenantId, sessionId);
    if (!session) throw new BrowserSessionNotFoundError(sessionId);
    if (session.status === 'migrating') {
      return {
        success: false,
        actionType: action.type,
        observation: 'Session is currently migrating. Please retry in a moment.',
        error: 'SESSION_MIGRATING',
      };
    }

    // Inflight lock
    const lockKey = K.inflight(tenantId, sessionId);
    await this.redis.set(lockKey, '1', 'EX', INFLIGHT_TTL_SECONDS);

    try {
      // Tenant validation
      if (session.tenantId !== tenantId) {
        throw new BrowserTenantViolationError(tenantId, session.tenantId, sessionId);
      }

      // Get or restore context
      let entry = this.contextPool.get(this.poolKey(tenantId, sessionId));
      if (!entry) {
        entry = await this.restoreSession(tenantId, sessionId, context.eventEmitter);
      }

      // Update last activity
      await this.updateLastActivity(tenantId, sessionId);

      // The actual dispatch is done by BrowserTool — return placeholder
      // (BrowserTool calls session manager helpers and dispatches to action classes)
      return {
        success: true,
        actionType: action.type,
        observation: 'Action dispatched.',
      };
    } finally {
      await this.redis.del(lockKey);
    }
  }

  async destroySession(tenantId: string, sessionId: string): Promise<void> {
    const session = await this.getSession(tenantId, sessionId);
    if (!session) return;

    const entry = this.contextPool.get(this.poolKey(tenantId, sessionId));

    // Extension backend
    if (session.backend === 'extension') {
      this.extensionBridge?.disconnectSession(sessionId);
      // Fall through to cleanup
    } else if (session.backend === 'persistent' && entry?.context) {
      // Snapshot profile before closing context
      if (this.profileStore && session.profileKey) {
        try {
          const profileDir = this.sandboxConfig.profileDir(tenantId, sessionId);
          await this.profileStore.snapshot(session.profileKey, profileDir);
        } catch (err) {
          this.logger.warn({ err, sessionId }, 'Profile snapshot failed on destroy.');
        }
      }
      try { await entry.context.close(); } catch { /* ignore */ }
    } else if (session.backend === 'userchrome' && entry?.context) {
      try {
        const browser = entry.context.browser?.();
        if (browser) await browser.close();
      } catch { /* ignore */ }
    } else if (entry?.context) {
      try { await entry.context.close(); } catch { /* ignore */ }
    }

    // Cleanup subsystems
    this.interceptRegistry.clearAll(entry?.context);
    this.logCollector.removeSession(sessionId);
    this.clearAllFrameStacks(tenantId, sessionId);
    this.extensionRegistry.clearSession(sessionId);
    this.dlpFilter.invalidateTenantCache(tenantId);
    this.pageRefs.delete(`${tenantId}:${sessionId}`);

    // Remove from pool
    this.contextPool.delete(this.poolKey(tenantId, sessionId));

    // Redis cleanup
    await this.redis.del(K.session(tenantId, sessionId));
    await this.tabRegistry.removeAll(tenantId, sessionId);
    await this.snapshotStore.delete(tenantId, sessionId);

    this.logger.info({ tenantId, sessionId }, 'Session destroyed.');
  }

  // ─── Frame Stack ──────────────────────────────────────────────────────────────

  pushFrame(tenantId: string, sessionId: string, tabId: string, frame: FrameRef): void {
    const key = this.frameKey(tenantId, sessionId, tabId);
    const stack = this.frameStacks.get(key) ?? [];
    stack.push(frame);
    this.frameStacks.set(key, stack);
  }

  popFrame(tenantId: string, sessionId: string, tabId: string): void {
    const key = this.frameKey(tenantId, sessionId, tabId);
    const stack = this.frameStacks.get(key) ?? [];
    stack.pop();
    this.frameStacks.set(key, stack);
  }

  clearFrameStack(tenantId: string, sessionId: string, tabId: string): void {
    this.frameStacks.delete(this.frameKey(tenantId, sessionId, tabId));
  }

  clearAllFrameStacks(tenantId: string, sessionId: string): void {
    for (const key of [...this.frameStacks.keys()]) {
      if (key.startsWith(`${tenantId}:${sessionId}:`)) {
        this.frameStacks.delete(key);
      }
    }
  }

  getFrameStack(tenantId: string, sessionId: string, tabId: string): FrameRef[] {
    return this.frameStacks.get(this.frameKey(tenantId, sessionId, tabId)) ?? [];
  }

  // ─── Page Ref Store (in-memory only) ──────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly pageRefs = new Map<string, Map<string, any>>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setPageRef(tenantId: string, sessionId: string, tabId: string, page: any): void {
    const sessionKey = `${tenantId}:${sessionId}`;
    if (!this.pageRefs.has(sessionKey)) {
      this.pageRefs.set(sessionKey, new Map());
    }
    this.pageRefs.get(sessionKey)!.set(tabId, page);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getPageRef(tenantId: string, sessionId: string, tabId: string): any | undefined {
    return this.pageRefs.get(`${tenantId}:${sessionId}`)?.get(tabId);
  }

  // ─── Context Access ──────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getContext(tenantId: string, sessionId: string): any {
    const entry = this.contextPool.get(this.poolKey(tenantId, sessionId));
    if (!entry?.context) throw new BrowserSessionNotFoundError(sessionId);
    return entry.context;
  }

  async getActiveTabId(tenantId: string, sessionId: string): Promise<string> {
    const session = await this.getSession(tenantId, sessionId);
    if (!session) throw new BrowserSessionNotFoundError(sessionId);
    return session.activeTabId;
  }

  async setActiveTabId(tenantId: string, sessionId: string, tabId: string): Promise<void> {
    const session = await this.getSession(tenantId, sessionId);
    if (!session) return;
    session.activeTabId = tabId;
    await this.persistSession(session);
  }

  async getBackend(tenantId: string, sessionId: string): Promise<string> {
    const session = await this.getSession(tenantId, sessionId);
    return session?.backend ?? 'local';
  }

  async listTabs(tenantId: string, sessionId: string): Promise<BrowserTabState[]> {
    return this.tabRegistry.list(tenantId, sessionId);
  }

  // ─── Session Snapshot ─────────────────────────────────────────────────────────

  async snapshotSession(tenantId: string, sessionId: string): Promise<void> {
    const entry = this.contextPool.get(this.poolKey(tenantId, sessionId));
    if (!entry?.context) return;
    try {
      const storageStateJson = await entry.context.storageState();
      const storageStateB64 = Buffer.from(JSON.stringify(storageStateJson)).toString('base64');
      const tabs = await this.tabRegistry.list(tenantId, sessionId);
      const snapshot: SessionSnapshot = {
        storageState: storageStateB64,
        tabs: tabs.map((t) => ({ tabId: t.tabId, url: t.url, isActive: t.isActive })),
        activeTabId: entry.session.activeTabId,
      };
      await this.snapshotStore.save(tenantId, sessionId, snapshot);
    } catch (err) {
      this.logger.warn({ err, sessionId }, 'Failed to snapshot session.');
    }
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────────

  private async createPersistentSession(
    tenantId: string,
    sessionId: string,
    taskId: string,
    config: BrowserSessionConfig,
    securityContext: IBrowserExecutionContext['securityContext'],
    emitter: IBrowserEventEmitter,
    options: CreateSessionOptions,
  ): Promise<BrowserSession> {
    let profileKey: string;

    if (options.useStealthPool && this.stealthPool) {
      const poolEntry = await this.stealthPool.acquire(tenantId);
      if (poolEntry) {
        profileKey = poolEntry.profileKey;
        emitter.emit('browser-stealth-pool-acquired', {
          profileId: poolEntry.profileId,
          personaId: poolEntry.personaId,
          sessionId,
        });
      } else {
        profileKey = `${tenantId}:${sessionId}`;
      }
    } else {
      profileKey = options.persistentProfileId ?? `${tenantId}:${sessionId}`;
    }

    const profileDir = this.sandboxConfig.profileDir(tenantId, sessionId);

    if (this.profileStore) {
      const restored = await this.profileStore.restore(profileKey, profileDir);
      emitter.emit('browser-profile-restored', {
        profileKey,
        sessionId,
        sizeBytes: 0,
        restored,
      });
    }

    const backend = await this.backendRouter.route(tenantId, 'persistent');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const context: any = await backend.launchContext(config, profileDir);

    const policy = DialogAutoPolicy.forAutonomous();
    this.dialogManager.attachToContext(context, sessionId, tenantId, taskId, emitter, policy);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page: any = await context.newPage();
    const tabId = crypto.randomUUID();
    this.logCollector.attachToPage(page, sessionId, emitter);

    await this.tabRegistry.register({
      tabId, sessionId, tenantId,
      url: page.url() || 'about:blank',
      title: await page.title().catch(() => ''),
      isActive: true,
    });

    const session: BrowserSession = {
      sessionId, tenantId, taskId,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      activeTabId: tabId,
      backend: 'persistent',
      profileKey,
      status: 'active',
    };

    this.contextPool.set(this.poolKey(tenantId, sessionId), { session, context });
    this.setPageRef(tenantId, sessionId, tabId, page);
    await this.persistSession(session);
    emitter.emit('browser-session-created', { sessionId, tenantId, backend: 'persistent' });
    return session;
  }

  private async acquireSharedSession(
    shareToken: string,
    receivingTenantId: string,
  ): Promise<BrowserSession> {
    // Lazy import jsonwebtoken
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const jwt = await import('jsonwebtoken');
    const secret = await this.vault.read(
      'oweibo/infra/browser/session-share-secret',
    ) as string;
    let payload: { tenantId: string; sessionId: string; exp: number };
    try {
      payload = jwt.verify(shareToken, secret) as typeof payload;
    } catch {
      throw new BrowserPolicyViolationError('Invalid or expired session share token.');
    }
    if (payload.tenantId !== receivingTenantId) {
      throw new BrowserPolicyViolationError(
        'Session share token tenantId does not match requesting tenant.',
      );
    }
    if (payload.exp * 1000 < Date.now()) {
      throw new BrowserPolicyViolationError('Session share token has expired.');
    }
    const session = await this.getSession(receivingTenantId, payload.sessionId);
    if (!session) throw new BrowserSessionNotFoundError(payload.sessionId);
    return session;
  }

  private async restoreSession(
    tenantId: string,
    sessionId: string,
    emitter: IBrowserEventEmitter,
  ): Promise<SessionEntry> {
    const session = await this.getSession(tenantId, sessionId);
    if (!session) throw new BrowserSessionNotFoundError(sessionId);

    const snapshot = await this.snapshotStore.load(tenantId, sessionId);
    if (!snapshot) throw new BrowserSessionNotFoundError(sessionId);

    const backend = await this.backendRouter.route(tenantId, session.backend);
    const storageState = snapshot.storageState
      ? JSON.parse(Buffer.from(snapshot.storageState, 'base64').toString())
      : undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const context: any = await backend.launchContext({
      tenantId,
      sessionId,
      taskId: session.taskId,
      backend: session.backend as BrowserSessionConfig['backend'],
      storageState: storageState ? JSON.stringify(storageState) : undefined,
    });

    const policy = DialogAutoPolicy.forAutonomous();
    this.dialogManager.attachToContext(context, sessionId, tenantId, session.taskId, emitter, policy);

    // Re-open tabs
    for (const tabSnap of snapshot.tabs) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const page: any = await context.newPage();
      if (tabSnap.url && tabSnap.url !== 'about:blank') {
        await page.goto(tabSnap.url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      }
      this.logCollector.attachToPage(page, sessionId, emitter);
      this.setPageRef(tenantId, sessionId, tabSnap.tabId, page);
    }

    const entry: SessionEntry = { session, context };
    this.contextPool.set(this.poolKey(tenantId, sessionId), entry);
    return entry;
  }

  private async getSession(
    tenantId: string,
    sessionId: string,
  ): Promise<BrowserSession | null> {
    const poolEntry = this.contextPool.get(this.poolKey(tenantId, sessionId));
    if (poolEntry) return poolEntry.session;
    const raw = await this.redis.get(K.session(tenantId, sessionId));
    return raw ? (JSON.parse(raw) as BrowserSession) : null;
  }

  private async persistSession(session: BrowserSession): Promise<void> {
    await this.redis.set(
      K.session(session.tenantId, session.sessionId),
      JSON.stringify(session),
      'EX',
      SESSION_TTL_SECONDS,
    );
    // Keep in-memory pool in sync
    const poolEntry = this.contextPool.get(this.poolKey(session.tenantId, session.sessionId));
    if (poolEntry) poolEntry.session = session;
  }

  private async updateLastActivity(tenantId: string, sessionId: string): Promise<void> {
    const session = await this.getSession(tenantId, sessionId);
    if (!session) return;
    session.lastActivityAt = new Date().toISOString();
    await this.persistSession(session);
  }

  private poolKey(tenantId: string, sessionId: string): string {
    return `${tenantId}:${sessionId}`;
  }

  private frameKey(tenantId: string, sessionId: string, tabId: string): string {
    return `${tenantId}:${sessionId}:${tabId}`;
  }
}

// ─── resolveLocator helper ──────────────────────────────────────────────────────

/**
 * Resolve a selector to a Locator, respecting the current frame stack.
 */
export function resolveLocator(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  selector: string,
  frameStack: FrameRef[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  if (frameStack.length === 0) return page.locator(selector);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let frameLocator: any = page.frameLocator(frameStack[0]!.selector);
  for (let i = 1; i < frameStack.length; i++) {
    frameLocator = frameLocator.frameLocator(frameStack[i]!.selector);
  }
  return frameLocator.locator(selector);
}
