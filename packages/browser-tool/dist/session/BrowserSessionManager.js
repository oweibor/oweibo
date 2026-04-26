"use strict";
/**
 * BrowserSessionManager — singleton per process, manages all browser sessions.
 *
 * Handles session lifecycle: create, execute action, snapshot, restore, destroy.
 * Enforces tenant isolation, concurrency limits, and integrates all subsystems.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserSessionManager = void 0;
exports.resolveLocator = resolveLocator;
const crypto = __importStar(require("crypto"));
const BrowserTabRegistry_js_1 = require("./BrowserTabRegistry.js");
const SessionSnapshotStore_js_1 = require("./SessionSnapshotStore.js");
const DialogManager_js_1 = require("./DialogManager.js");
const DialogAutoPolicy_js_1 = require("./DialogAutoPolicy.js");
const NetworkInterceptRegistry_js_1 = require("./NetworkInterceptRegistry.js");
const BrowserLogCollector_js_1 = require("./BrowserLogCollector.js");
const BrowserDlpFilter_js_1 = require("./BrowserDlpFilter.js");
const BrowserExtensionRegistry_js_1 = require("./BrowserExtensionRegistry.js");
const ScreenshotWatermarker_js_1 = require("./ScreenshotWatermarker.js");
const BrowserCredentialStore_js_1 = require("./BrowserCredentialStore.js");
const DomainReputationStore_js_1 = require("./DomainReputationStore.js");
const errors_js_1 = require("../contracts/errors.js");
const SESSION_TTL_SECONDS = 4 * 60 * 60; // 4 hours
const INFLIGHT_TTL_SECONDS = 60;
const K = {
    session: (tenantId, sessionId) => `oweibo:browser:${tenantId}:session:${sessionId}`,
    inflight: (tenantId, sessionId) => `oweibo:${tenantId}:browser-inflight:${sessionId}`,
};
class BrowserSessionManager {
    redis;
    vault;
    logger;
    sandboxConfig;
    profileStore;
    stealthPool;
    extensionBridge;
    backendRouter;
    globalMaxSessions;
    maxSessionsPerTenant;
    sessionRouter;
    // Core state
    contextPool = new Map();
    // In-memory frame stacks: key = `${tenantId}:${sessionId}:${tabId}`
    frameStacks = new Map();
    // Subsystems
    tabRegistry;
    snapshotStore;
    dialogManager;
    interceptRegistry;
    logCollector;
    dlpFilter;
    extensionRegistry;
    watermarker;
    credentialStore;
    domainReputation;
    constructor(redis, vault, logger, sandboxConfig, profileStore, stealthPool, extensionBridge, backendRouter, globalMaxSessions, maxSessionsPerTenant, sessionRouter = null) {
        this.redis = redis;
        this.vault = vault;
        this.logger = logger;
        this.sandboxConfig = sandboxConfig;
        this.profileStore = profileStore;
        this.stealthPool = stealthPool;
        this.extensionBridge = extensionBridge;
        this.backendRouter = backendRouter;
        this.globalMaxSessions = globalMaxSessions;
        this.maxSessionsPerTenant = maxSessionsPerTenant;
        this.sessionRouter = sessionRouter;
        this.tabRegistry = new BrowserTabRegistry_js_1.BrowserTabRegistry(redis);
        this.snapshotStore = new SessionSnapshotStore_js_1.SessionSnapshotStore(redis);
        this.dialogManager = new DialogManager_js_1.DialogManager();
        this.interceptRegistry = new NetworkInterceptRegistry_js_1.NetworkInterceptRegistry();
        this.logCollector = new BrowserLogCollector_js_1.BrowserLogCollector();
        this.dlpFilter = new BrowserDlpFilter_js_1.BrowserDlpFilter(vault);
        this.extensionRegistry = new BrowserExtensionRegistry_js_1.BrowserExtensionRegistry(vault, logger);
        this.watermarker = new ScreenshotWatermarker_js_1.ScreenshotWatermarker(vault, logger);
        this.credentialStore = new BrowserCredentialStore_js_1.BrowserCredentialStore(vault, logger);
        this.domainReputation = new DomainReputationStore_js_1.DomainReputationStore(vault, redis, logger);
    }
    // ─── Session Lifecycle ───────────────────────────────────────────────────────
    async createSession(tenantId, sessionId, taskId, config, securityContext, emitter, options = {}) {
        // Concurrency guards
        if (this.contextPool.size >= this.globalMaxSessions) {
            throw new errors_js_1.BrowserSessionLimitError(`Global session limit (${this.globalMaxSessions}) reached.`);
        }
        const tenantCount = [...this.contextPool.values()].filter((e) => e.session.tenantId === tenantId).length;
        if (tenantCount >= this.maxSessionsPerTenant) {
            throw new errors_js_1.BrowserSessionLimitError(`Per-tenant session limit (${this.maxSessionsPerTenant}) reached for tenant "${tenantId}".`);
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
                        targetUrl: config.initialUrl ?? '',
                        securityContext,
                        taskHint: options.taskHint,
                    });
                    const decision = await this.sessionRouter.selectBackend(routingCtx);
                    config = { ...config, backend: decision.backend };
                    if (decision.useStealthPool) {
                        options = { ...options, useStealthPool: true };
                    }
                    emitter.emit('browser-backend-auto-selected', {
                        tenantId,
                        sessionId,
                        selected: decision.backend,
                        reason: decision.reason,
                        useStealthPool: decision.useStealthPool,
                    });
                }
                catch (err) {
                    this.logger.warn({ err, tenantId }, 'BrowserSessionRouter.selectBackend failed; falling back to local');
                    config = { ...config, backend: 'local' };
                }
            }
            else {
                // No router configured — safe fallback
                config = { ...config, backend: 'local' };
            }
        }
        // Extension backend
        if (config.backend === 'extension') {
            if (!securityContext.allowExtensionBridge) {
                throw new errors_js_1.BrowserPolicyViolationError('Extension backend requires allowExtensionBridge trust gate.');
            }
            if (!this.extensionBridge) {
                throw new errors_js_1.BrowserPolicyViolationError('ExtensionBridgeServer not configured.');
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
            const session = {
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
                throw new errors_js_1.BrowserPolicyViolationError('Persistent profile backend requires allowPersistentProfile trust gate.');
            }
            return this.createPersistentSession(tenantId, sessionId, taskId, config, securityContext, emitter, options);
        }
        // UserChrome CDP backend
        if (config.backend === 'userchrome') {
            if (!securityContext.allowUserChrome) {
                throw new errors_js_1.BrowserPolicyViolationError('UserChrome backend requires allowUserChrome trust gate.');
            }
        }
        // Standard backend launch
        const backend = await this.backendRouter.route(tenantId, config.backend);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const context = await backend.launchContext(config);
        // Attach subsystems
        const policy = DialogAutoPolicy_js_1.DialogAutoPolicy.forAutonomous();
        this.dialogManager.attachToContext(context, sessionId, tenantId, taskId, emitter, policy);
        // Open initial page
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const page = await context.newPage();
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
        const session = {
            sessionId,
            tenantId,
            taskId,
            createdAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
            activeTabId: tabId,
            // config.backend is always resolved from 'auto' before reaching here
            backend: config.backend,
            status: 'active',
        };
        // Store page ref in tab state (in-memory only)
        const entry = { session, context };
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
    async executeAction(action, context) {
        const { tenantId, sessionId } = context;
        // Migration guard
        const session = await this.getSession(tenantId, sessionId);
        if (!session)
            throw new errors_js_1.BrowserSessionNotFoundError(sessionId);
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
                throw new errors_js_1.BrowserTenantViolationError(tenantId, session.tenantId, sessionId);
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
        }
        finally {
            await this.redis.del(lockKey);
        }
    }
    async destroySession(tenantId, sessionId) {
        const session = await this.getSession(tenantId, sessionId);
        if (!session)
            return;
        const entry = this.contextPool.get(this.poolKey(tenantId, sessionId));
        // Extension backend
        if (session.backend === 'extension') {
            this.extensionBridge?.disconnectSession(sessionId);
            // Fall through to cleanup
        }
        else if (session.backend === 'persistent' && entry?.context) {
            // Snapshot profile before closing context
            if (this.profileStore && session.profileKey) {
                try {
                    const profileDir = this.sandboxConfig.profileDir(tenantId, sessionId);
                    await this.profileStore.snapshot(session.profileKey, profileDir);
                }
                catch (err) {
                    this.logger.warn({ err, sessionId }, 'Profile snapshot failed on destroy.');
                }
            }
            try {
                await entry.context.close();
            }
            catch { /* ignore */ }
        }
        else if (session.backend === 'userchrome' && entry?.context) {
            try {
                const browser = entry.context.browser?.();
                if (browser)
                    await browser.close();
            }
            catch { /* ignore */ }
        }
        else if (entry?.context) {
            try {
                await entry.context.close();
            }
            catch { /* ignore */ }
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
    pushFrame(tenantId, sessionId, tabId, frame) {
        const key = this.frameKey(tenantId, sessionId, tabId);
        const stack = this.frameStacks.get(key) ?? [];
        stack.push(frame);
        this.frameStacks.set(key, stack);
    }
    popFrame(tenantId, sessionId, tabId) {
        const key = this.frameKey(tenantId, sessionId, tabId);
        const stack = this.frameStacks.get(key) ?? [];
        stack.pop();
        this.frameStacks.set(key, stack);
    }
    clearFrameStack(tenantId, sessionId, tabId) {
        this.frameStacks.delete(this.frameKey(tenantId, sessionId, tabId));
    }
    clearAllFrameStacks(tenantId, sessionId) {
        for (const key of [...this.frameStacks.keys()]) {
            if (key.startsWith(`${tenantId}:${sessionId}:`)) {
                this.frameStacks.delete(key);
            }
        }
    }
    getFrameStack(tenantId, sessionId, tabId) {
        return this.frameStacks.get(this.frameKey(tenantId, sessionId, tabId)) ?? [];
    }
    // ─── Page Ref Store (in-memory only) ──────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pageRefs = new Map();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setPageRef(tenantId, sessionId, tabId, page) {
        const sessionKey = `${tenantId}:${sessionId}`;
        if (!this.pageRefs.has(sessionKey)) {
            this.pageRefs.set(sessionKey, new Map());
        }
        this.pageRefs.get(sessionKey).set(tabId, page);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getPageRef(tenantId, sessionId, tabId) {
        return this.pageRefs.get(`${tenantId}:${sessionId}`)?.get(tabId);
    }
    // ─── Context Access ──────────────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getContext(tenantId, sessionId) {
        const entry = this.contextPool.get(this.poolKey(tenantId, sessionId));
        if (!entry?.context)
            throw new errors_js_1.BrowserSessionNotFoundError(sessionId);
        return entry.context;
    }
    async getActiveTabId(tenantId, sessionId) {
        const session = await this.getSession(tenantId, sessionId);
        if (!session)
            throw new errors_js_1.BrowserSessionNotFoundError(sessionId);
        return session.activeTabId;
    }
    async setActiveTabId(tenantId, sessionId, tabId) {
        const session = await this.getSession(tenantId, sessionId);
        if (!session)
            return;
        session.activeTabId = tabId;
        await this.persistSession(session);
    }
    async getBackend(tenantId, sessionId) {
        const session = await this.getSession(tenantId, sessionId);
        return session?.backend ?? 'local';
    }
    async listTabs(tenantId, sessionId) {
        return this.tabRegistry.list(tenantId, sessionId);
    }
    // ─── Session Snapshot ─────────────────────────────────────────────────────────
    async snapshotSession(tenantId, sessionId) {
        const entry = this.contextPool.get(this.poolKey(tenantId, sessionId));
        if (!entry?.context)
            return;
        try {
            const storageStateJson = await entry.context.storageState();
            const storageStateB64 = Buffer.from(JSON.stringify(storageStateJson)).toString('base64');
            const tabs = await this.tabRegistry.list(tenantId, sessionId);
            const snapshot = {
                storageState: storageStateB64,
                tabs: tabs.map((t) => ({ tabId: t.tabId, url: t.url, isActive: t.isActive })),
                activeTabId: entry.session.activeTabId,
            };
            await this.snapshotStore.save(tenantId, sessionId, snapshot);
        }
        catch (err) {
            this.logger.warn({ err, sessionId }, 'Failed to snapshot session.');
        }
    }
    // ─── Private Helpers ──────────────────────────────────────────────────────────
    async createPersistentSession(tenantId, sessionId, taskId, config, securityContext, emitter, options) {
        let profileKey;
        if (options.useStealthPool && this.stealthPool) {
            const poolEntry = await this.stealthPool.acquire(tenantId);
            if (poolEntry) {
                profileKey = poolEntry.profileKey;
                emitter.emit('browser-stealth-pool-acquired', {
                    profileId: poolEntry.profileId,
                    personaId: poolEntry.personaId,
                    sessionId,
                });
            }
            else {
                profileKey = `${tenantId}:${sessionId}`;
            }
        }
        else {
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
        const context = await backend.launchContext(config, profileDir);
        const policy = DialogAutoPolicy_js_1.DialogAutoPolicy.forAutonomous();
        this.dialogManager.attachToContext(context, sessionId, tenantId, taskId, emitter, policy);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const page = await context.newPage();
        const tabId = crypto.randomUUID();
        this.logCollector.attachToPage(page, sessionId, emitter);
        await this.tabRegistry.register({
            tabId, sessionId, tenantId,
            url: page.url() || 'about:blank',
            title: await page.title().catch(() => ''),
            isActive: true,
        });
        const session = {
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
    async acquireSharedSession(shareToken, receivingTenantId) {
        // Lazy import jsonwebtoken
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const jwt = await import('jsonwebtoken');
        const secret = await this.vault.read('oweibo/infra/browser/session-share-secret');
        let payload;
        try {
            payload = jwt.verify(shareToken, secret);
        }
        catch {
            throw new errors_js_1.BrowserPolicyViolationError('Invalid or expired session share token.');
        }
        if (payload.tenantId !== receivingTenantId) {
            throw new errors_js_1.BrowserPolicyViolationError('Session share token tenantId does not match requesting tenant.');
        }
        if (payload.exp * 1000 < Date.now()) {
            throw new errors_js_1.BrowserPolicyViolationError('Session share token has expired.');
        }
        const session = await this.getSession(receivingTenantId, payload.sessionId);
        if (!session)
            throw new errors_js_1.BrowserSessionNotFoundError(payload.sessionId);
        return session;
    }
    async restoreSession(tenantId, sessionId, emitter) {
        const session = await this.getSession(tenantId, sessionId);
        if (!session)
            throw new errors_js_1.BrowserSessionNotFoundError(sessionId);
        const snapshot = await this.snapshotStore.load(tenantId, sessionId);
        if (!snapshot)
            throw new errors_js_1.BrowserSessionNotFoundError(sessionId);
        const backend = await this.backendRouter.route(tenantId, session.backend);
        const storageState = snapshot.storageState
            ? JSON.parse(Buffer.from(snapshot.storageState, 'base64').toString())
            : undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const context = await backend.launchContext({
            tenantId,
            sessionId,
            taskId: session.taskId,
            backend: session.backend,
            storageState: storageState ? JSON.stringify(storageState) : undefined,
        });
        const policy = DialogAutoPolicy_js_1.DialogAutoPolicy.forAutonomous();
        this.dialogManager.attachToContext(context, sessionId, tenantId, session.taskId, emitter, policy);
        // Re-open tabs
        for (const tabSnap of snapshot.tabs) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const page = await context.newPage();
            if (tabSnap.url && tabSnap.url !== 'about:blank') {
                await page.goto(tabSnap.url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => { });
            }
            this.logCollector.attachToPage(page, sessionId, emitter);
            this.setPageRef(tenantId, sessionId, tabSnap.tabId, page);
        }
        const entry = { session, context };
        this.contextPool.set(this.poolKey(tenantId, sessionId), entry);
        return entry;
    }
    async getSession(tenantId, sessionId) {
        const poolEntry = this.contextPool.get(this.poolKey(tenantId, sessionId));
        if (poolEntry)
            return poolEntry.session;
        const raw = await this.redis.get(K.session(tenantId, sessionId));
        return raw ? JSON.parse(raw) : null;
    }
    async persistSession(session) {
        await this.redis.set(K.session(session.tenantId, session.sessionId), JSON.stringify(session), 'EX', SESSION_TTL_SECONDS);
        // Keep in-memory pool in sync
        const poolEntry = this.contextPool.get(this.poolKey(session.tenantId, session.sessionId));
        if (poolEntry)
            poolEntry.session = session;
    }
    async updateLastActivity(tenantId, sessionId) {
        const session = await this.getSession(tenantId, sessionId);
        if (!session)
            return;
        session.lastActivityAt = new Date().toISOString();
        await this.persistSession(session);
    }
    poolKey(tenantId, sessionId) {
        return `${tenantId}:${sessionId}`;
    }
    frameKey(tenantId, sessionId, tabId) {
        return `${tenantId}:${sessionId}:${tabId}`;
    }
}
exports.BrowserSessionManager = BrowserSessionManager;
// ─── resolveLocator helper ──────────────────────────────────────────────────────
/**
 * Resolve a selector to a Locator, respecting the current frame stack.
 */
function resolveLocator(
// eslint-disable-next-line @typescript-eslint/no-explicit-any
page, selector, frameStack) {
    if (frameStack.length === 0)
        return page.locator(selector);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let frameLocator = page.frameLocator(frameStack[0].selector);
    for (let i = 1; i < frameStack.length; i++) {
        frameLocator = frameLocator.frameLocator(frameStack[i].selector);
    }
    return frameLocator.locator(selector);
}
//# sourceMappingURL=BrowserSessionManager.js.map