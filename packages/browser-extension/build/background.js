/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ "./src/bridge/ExtensionBridgeServer.ts"
/*!*********************************************!*\
  !*** ./src/bridge/ExtensionBridgeServer.ts ***!
  \*********************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ExtensionBridgeServer: () => (/* binding */ ExtensionBridgeServer)
/* harmony export */ });
// packages/browser-extension/src/bridge/ExtensionBridgeServer.ts
// @deprecated — Legacy WebSocket transport retained for extensionBridgeMode:'websocket'.
//              Default transport in v9.5.9 is NativeMessagingBridge (stdio pipe).
//
// Extension-side WebSocket client that connects to the Node.js
// ExtensionBridgeServer running in browser-tool/src/session/. Encapsulates
// the browser WebSocket API used inside the MV3 service worker.
//
// The server side (Node.js ws package) lives in browser-tool/src/session/ExtensionBridgeServer.ts.
/** @deprecated Use NativeMessagingBridge instead. */
class ExtensionBridgeServer {
    ws = null;
    actionHandler = null;
    gateHandler = null;
    onAction(handler) { this.actionHandler = handler; }
    onGate(handler) { this.gateHandler = handler; }
    isConnected() {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }
    connect(host) {
        if (this.isConnected())
            return Promise.resolve();
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(host);
            ws.onopen = () => { this.ws = ws; resolve(); };
            ws.onclose = () => { this.ws = null; };
            ws.onerror = (e) => { reject(new Error(`[oweibo-bridge-legacy] ws error: ${String(e)}`)); };
            ws.onmessage = (ev) => { void this.handleMessage(ev.data); };
        });
    }
    disconnect() {
        this.ws?.close();
        this.ws = null;
    }
    /** Send an action result back to the Node.js server. */
    sendResult(callId, result, error) {
        if (!this.isConnected())
            return;
        this.ws.send(JSON.stringify({ kind: 'action-result', callId, result, error }));
    }
    /** Send a gate-resolved notification back to the server. */
    sendGateResolved(gateId, accept) {
        if (!this.isConnected())
            return;
        this.ws.send(JSON.stringify({ kind: 'hitl-resolve', gateId, accept }));
    }
    async handleMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        }
        catch {
            console.error('[oweibo-bridge-legacy] unparseable message');
            return;
        }
        const m = msg;
        if (m['kind'] === 'action' && typeof m['callId'] === 'string') {
            const callId = m['callId'];
            const tabId = m['tabId'] ?? 0;
            const action = m['action'];
            try {
                const result = await this.actionHandler?.(action, callId, tabId);
                this.sendResult(callId, result);
            }
            catch (e) {
                this.sendResult(callId, null, e.message);
            }
            return;
        }
        if (m['kind'] === 'hitl-open' && m['gate']) {
            const gate = m['gate'];
            const tabId = m['tabId'] ?? 0;
            try {
                await this.gateHandler?.(gate, tabId);
            }
            catch (e) {
                console.error('[oweibo-bridge-legacy] gate handler error:', e.message);
            }
            return;
        }
    }
}


/***/ },

/***/ "./src/bridge/ExtensionHITLBridge.ts"
/*!*******************************************!*\
  !*** ./src/bridge/ExtensionHITLBridge.ts ***!
  \*******************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ExtensionHITLBridge: () => (/* binding */ ExtensionHITLBridge)
/* harmony export */ });
// packages/browser-extension/src/bridge/ExtensionHITLBridge.ts
// Single point of entry for all HITL (human-in-the-loop) gate lifecycle events
// flowing between the pipeline and the three user-facing surfaces:
//   1. Extension popup gate card
//   2. InTabHITLOverlay (floating panel injected into the active tab)
//   3. DesktopNotificationFallback (OS notification when tab is backgrounded)
//
// Delegates gate registration and resolution to HITLSurfaceCoordinator, which
// owns the first-response-wins semantics. The popup path and badge updates are
// also managed here so background.ts stays thin.
//
// v9.5.9 — replaces the inline gate handling that was previously scattered
//           across background.ts.
class ExtensionHITLBridge {
    coordinator;
    native;
    legacy;
    constructor(deps) {
        this.coordinator = deps.coordinator;
        this.native = deps.nativeBridge;
        this.legacy = deps.legacyBridge;
    }
    /**
     * Open a HITL gate: fan out to in-tab overlay, OS notification, and popup
     * simultaneously via HITLSurfaceCoordinator.
     */
    async openGate(gate, tabId) {
        await this.coordinator.open(gate, tabId);
        // Notify popup (fire-and-forget; popup may not be open)
        this.sendToPopup({ type: 'hitl-gate', gate });
    }
    /**
     * Resolve a gate — idempotent. Called by any surface (overlay, notification,
     * popup) that wins the first-response race.
     * Forwards the resolved gate back to the pipeline via whichever transport is active.
     */
    async resolveGate(resolution) {
        // coordinator.resolve() is idempotent; subsequent calls are no-ops.
        await this.coordinator.resolve(resolution);
        this.sendToPopup({ type: 'hitl-dismiss', gateId: resolution.gateId });
        this.updateBadge();
    }
    /**
     * Called by background.ts when a chrome.runtime.onMessage arrives from the
     * popup carrying a resolution.
     */
    async handlePopupResolve(gateId, accept, promptText) {
        await this.resolveGate({ gateId, accept, promptText, resolvedBy: 'popup' });
    }
    /** List all pending gates for the popup to render. */
    listPending() {
        return this.coordinator.listPending();
    }
    pendingCount() {
        return this.coordinator.pendingCount();
    }
    // ─── Private helpers ───────────────────────────────────────────────────────
    sendToPopup(message) {
        try {
            void chrome.runtime.sendMessage(message).catch(() => {
                // Popup not open — suppress the error.
            });
        }
        catch {
            // Service worker context may reject chrome.runtime.sendMessage if there are
            // no listeners. Silence it.
        }
    }
    updateBadge() {
        const n = this.coordinator.pendingCount();
        try {
            void chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' });
            void chrome.action.setBadgeBackgroundColor({ color: '#d04a4a' });
        }
        catch { /* MV3 worker may be starting */ }
    }
}


/***/ },

/***/ "./src/bridge/NativeMessagingBridge.ts"
/*!*********************************************!*\
  !*** ./src/bridge/NativeMessagingBridge.ts ***!
  \*********************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   NativeMessagingBridge: () => (/* binding */ NativeMessagingBridge)
/* harmony export */ });
// packages/browser-extension/src/bridge/NativeMessagingBridge.ts
// Default transport in v9.5.9. Replaces ExtensionBridgeServer WebSocket with
// Chrome-managed stdio via chrome.runtime.connectNative. Same HMAC-per-message
// authentication scheme; no port binding; no separate server process.
const NATIVE_HOST_NAME = 'com.oweibo.browser';
/** Subtle-crypto HMAC-SHA256 over the canonical JSON of (callId + action|result). */
async function computeHmac(key, payload) {
    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(payload));
    return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
async function verifyHmac(msg, key) {
    if (!msg.hmac)
        return false;
    const { hmac: _h, ...rest } = msg;
    const expected = await computeHmac(key, JSON.stringify(rest));
    return expected === msg.hmac;
}
class NativeMessagingBridge {
    port = null;
    pending = new Map();
    hmacToken = '';
    inboundAction = null;
    inboundGate = null;
    /** Register the function that runs host-initiated actions against the browser. */
    onInboundAction(handler) { this.inboundAction = handler; }
    /** Register the function that opens a HITL gate surface in a tab. */
    onInboundGate(handler) { this.inboundGate = handler; }
    connect(hmacToken) {
        if (this.port)
            return;
        this.hmacToken = hmacToken;
        try {
            this.port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
        }
        catch (e) {
            console.error('[oweibo-bridge] native host connect failed:', e);
            this.port = null;
            return;
        }
        this.port.onMessage.addListener((msg) => { void this.handleIncoming(msg); });
        this.port.onDisconnect.addListener(() => {
            const err = chrome.runtime.lastError?.message ?? 'disconnected';
            console.warn('[oweibo-bridge] native host disconnected:', err);
            this.failAll(new Error(err));
            this.port = null;
        });
    }
    isConnected() { return this.port !== null; }
    async sendAction(callId, action) {
        if (!this.port)
            throw new Error('NativeMessagingBridge: not connected');
        const body = { callId, action, direction: 'request' };
        body.hmac = await computeHmac(this.hmacToken, this.canonicalize(body));
        return new Promise((resolve, reject) => {
            this.pending.set(callId, { resolve, reject });
            this.port.postMessage(body);
        });
    }
    /** Post a response to an earlier inbound (host→extension) request. */
    async sendResponse(callId, result, error) {
        if (!this.port)
            return;
        const body = { callId, result, error, direction: 'response' };
        body.hmac = await computeHmac(this.hmacToken, this.canonicalize(body));
        this.port.postMessage(body);
    }
    canonicalize(msg) {
        // Exclude the hmac field itself — verification side recomputes over the
        // same excluded-hmac shape.
        const { hmac: _h, ...rest } = msg;
        return JSON.stringify(rest);
    }
    async handleIncoming(msg) {
        if (!(await verifyHmac(msg, this.hmacToken))) {
            console.error('[oweibo-bridge] HMAC mismatch; dropping message', msg.callId);
            return;
        }
        // Response to one of our outbound calls.
        if (msg.direction === 'response' || this.pending.has(msg.callId)) {
            const entry = this.pending.get(msg.callId);
            if (!entry)
                return;
            this.pending.delete(msg.callId);
            if (msg.error)
                entry.reject(new Error(msg.error));
            else
                entry.resolve(msg.result);
            return;
        }
        // Inbound gate open request from host.
        if (msg.gate && typeof msg.tabId === 'number' && this.inboundGate) {
            try {
                await this.inboundGate(msg.gate, msg.tabId);
                await this.sendResponse(msg.callId, { ok: true });
            }
            catch (e) {
                await this.sendResponse(msg.callId, null, e.message);
            }
            return;
        }
        // Inbound action request from host.
        if (msg.action && typeof msg.tabId === 'number') {
            if (!this.inboundAction) {
                await this.sendResponse(msg.callId, null, 'no inbound action handler registered');
                return;
            }
            try {
                const result = await this.inboundAction(msg.action, msg.tabId);
                await this.sendResponse(msg.callId, result);
            }
            catch (e) {
                await this.sendResponse(msg.callId, null, e.message);
            }
            return;
        }
        console.warn('[oweibo-bridge] dropping unroutable message', msg.callId);
    }
    failAll(err) {
        for (const { reject } of this.pending.values())
            reject(err);
        this.pending.clear();
    }
}


/***/ },

/***/ "./src/content/ContentScriptActionEngine.ts"
/*!**************************************************!*\
  !*** ./src/content/ContentScriptActionEngine.ts ***!
  \**************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ContentScriptActionEngine: () => (/* binding */ ContentScriptActionEngine)
/* harmony export */ });
// packages/browser-extension/src/content/ContentScriptActionEngine.ts
// Background-side dispatcher for the 38 DOM actions that run inside the page
// document via a content script. Produces isTrusted: true events —
// indistinguishable from real user gestures to PerimeterX, DataDome, Akamai.
//
// The 13 page-level actions listed in shared/actions.ts:DEBUGGER_ACTIONS are
// NOT handled here — callers dispatch those through DebuggerLifecycleManager.
class ContentScriptActionEngine {
    injectedTabs = new Set();
    /** Inject content-script.js (idempotent) then post the action via sendMessage. */
    async dispatch(tabId, action) {
        try {
            await this.ensureInjected(tabId);
            const result = (await chrome.tabs.sendMessage(tabId, { __oweibo: true, action }));
            return result ?? { success: false, error: 'no response from content script' };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    }
    async ensureInjected(tabId) {
        if (this.injectedTabs.has(tabId))
            return;
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content-script.js'],
        });
        this.injectedTabs.add(tabId);
    }
    /** Called by tabs.onRemoved / onUpdated to drop stale cache entries. */
    forget(tabId) { this.injectedTabs.delete(tabId); }
}


/***/ },

/***/ "./src/content/DebuggerLifecycleManager.ts"
/*!*************************************************!*\
  !*** ./src/content/DebuggerLifecycleManager.ts ***!
  \*************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   DebuggerLifecycleManager: () => (/* binding */ DebuggerLifecycleManager)
/* harmony export */ });
// packages/browser-extension/src/content/DebuggerLifecycleManager.ts
// Lazy chrome.debugger attach/detach. Default policy is 'lazy': attach just
// before each page-level action, detach immediately after. For content-script-
// only flows chrome.debugger is never touched, so the yellow banner is absent.
const DEBUGGER_VERSION = '1.3';
class DebuggerLifecycleManager {
    policy;
    attachedTabs = new Set();
    constructor(policy = 'lazy') {
        this.policy = policy;
    }
    /** Run `fn` with chrome.debugger attached to `tabId` per the active policy. */
    async withDebugger(tabId, fn) {
        if (this.policy === 'persistent') {
            await this.ensureAttached(tabId);
            return fn();
        }
        await this.ensureAttached(tabId);
        try {
            return await fn();
        }
        finally {
            await this.detach(tabId);
        }
    }
    async ensureAttached(tabId) {
        if (this.attachedTabs.has(tabId))
            return;
        await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
        this.attachedTabs.add(tabId);
    }
    async detach(tabId) {
        if (!this.attachedTabs.has(tabId))
            return;
        try {
            await chrome.debugger.detach({ tabId });
        }
        catch (e) {
            console.warn('[oweibo-debugger] detach failed:', e.message);
        }
        this.attachedTabs.delete(tabId);
    }
    async detachAll() {
        await Promise.allSettled([...this.attachedTabs].map(id => this.detach(id)));
    }
}


/***/ },

/***/ "./src/hitl/DesktopNotificationFallback.ts"
/*!*************************************************!*\
  !*** ./src/hitl/DesktopNotificationFallback.ts ***!
  \*************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   DesktopNotificationFallback: () => (/* binding */ DesktopNotificationFallback)
/* harmony export */ });
// packages/browser-extension/src/hitl/DesktopNotificationFallback.ts
// Fires an OS notification for a gate when its tab is backgrounded. If the
// user is looking at the tab, the in-tab overlay is sufficient and we skip.
// Buttons on the notification resolve the gate directly (accept / dismiss);
// clicking the body focuses the tab so the overlay becomes visible.
class DesktopNotificationFallback {
    shown = new Map();
    resolver = null;
    wired = false;
    onResolve(handler) {
        this.resolver = handler;
        if (this.wired)
            return;
        this.wired = true;
        chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
            const entry = this.shown.get(notificationId);
            if (!entry)
                return;
            this.resolver?.({
                gateId: entry.gateId,
                accept: buttonIndex === 0,
                resolvedBy: 'notification',
            });
        });
        chrome.notifications.onClicked.addListener((notificationId) => {
            const entry = this.shown.get(notificationId);
            if (!entry)
                return;
            void chrome.tabs.update(entry.tabId, { active: true });
        });
    }
    async show(gate, tabId) {
        try {
            const tab = await chrome.tabs.get(tabId);
            const win = tab.windowId != null ? await chrome.windows.get(tab.windowId) : undefined;
            if (tab.active && win?.focused)
                return; // foregrounded — overlay is enough
            const notificationId = `oweibo-hitl-${gate.gateId}`;
            await chrome.notifications.create(notificationId, {
                type: 'basic',
                iconUrl: 'icons/icon128.png',
                title: 'Oweibo needs your approval',
                message: gate.message,
                buttons: [{ title: 'Accept' }, { title: 'Dismiss' }],
                requireInteraction: true,
                priority: 2,
            });
            this.shown.set(notificationId, { gateId: gate.gateId, tabId });
        }
        catch (e) {
            console.warn('[oweibo-hitl] notification show failed:', e.message);
        }
    }
    async dismiss(gateId) {
        const id = `oweibo-hitl-${gateId}`;
        try {
            await chrome.notifications.clear(id);
        }
        catch { /* no-op */ }
        this.shown.delete(id);
    }
}


/***/ },

/***/ "./src/hitl/HITLSurfaceCoordinator.ts"
/*!********************************************!*\
  !*** ./src/hitl/HITLSurfaceCoordinator.ts ***!
  \********************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   HITLSurfaceCoordinator: () => (/* binding */ HITLSurfaceCoordinator)
/* harmony export */ });
// packages/browser-extension/src/hitl/HITLSurfaceCoordinator.ts
// Single gate lifecycle authority for the unified three-surface HITL system.
// All surfaces (in-tab overlay, OS notification, popup) register through it.
// First response wins; all others dismiss instantly. Idempotent by gateId.
class HITLSurfaceCoordinator {
    overlay;
    notification;
    sink;
    gates = new Map();
    constructor(overlay, notification, sink) {
        this.overlay = overlay;
        this.notification = notification;
        this.sink = sink;
        this.notification.onResolve((r) => void this.resolve(r));
    }
    pendingCount() {
        let n = 0;
        for (const g of this.gates.values())
            if (!g.resolved)
                n++;
        return n;
    }
    listPending() {
        return [...this.gates.values()].filter(g => !g.resolved).map(g => g.gate);
    }
    async open(gate, tabId) {
        if (this.gates.has(gate.gateId))
            return;
        this.gates.set(gate.gateId, { gate, tabId, resolved: false });
        await Promise.allSettled([
            this.overlay.show(gate, tabId),
            this.notification.show(gate, tabId),
        ]);
        this.updateBadge();
    }
    async resolve(resolution) {
        const entry = this.gates.get(resolution.gateId);
        if (!entry || entry.resolved)
            return; // idempotent
        entry.resolved = true;
        this.gates.delete(resolution.gateId);
        await Promise.allSettled([
            this.overlay.dismiss(resolution.gateId, entry.tabId),
            this.notification.dismiss(resolution.gateId),
            this.sink.onResolved(resolution),
        ]);
        this.updateBadge();
    }
    updateBadge() {
        const n = this.pendingCount();
        try {
            void chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' });
            void chrome.action.setBadgeBackgroundColor({ color: '#d04a4a' });
        }
        catch { /* MV3 worker may be starting; ignore */ }
    }
}


/***/ },

/***/ "./src/hitl/InTabHITLOverlay.ts"
/*!**************************************!*\
  !*** ./src/hitl/InTabHITLOverlay.ts ***!
  \**************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   InTabHITLOverlay: () => (/* binding */ InTabHITLOverlay)
/* harmony export */ });
// packages/browser-extension/src/hitl/InTabHITLOverlay.ts
// Background-side controller that injects hitl-overlay.js into a target tab
// on demand and posts show/dismiss messages to the overlay running inside it.
//
// The in-tab overlay is a floating panel top-right of the page with
// Accept/Dismiss buttons. Multiple concurrent gates stack vertically.
// Injection silently skips restricted tabs (chrome://, file://, webstore).
const RESTRICTED_PREFIXES = ['chrome://', 'chrome-extension://', 'edge://', 'about:', 'file://', 'https://chromewebstore.google.com'];
class InTabHITLOverlay {
    injected = new Set();
    async show(gate, tabId) {
        if (!(await this.tryInject(tabId)))
            return;
        try {
            await chrome.tabs.sendMessage(tabId, { __oweiboHitl: 'show', gate });
        }
        catch (e) {
            console.warn('[oweibo-hitl] overlay show failed:', e.message);
        }
    }
    async dismiss(gateId, tabId) {
        try {
            await chrome.tabs.sendMessage(tabId, { __oweiboHitl: 'dismiss', gateId });
        }
        catch { /* tab may have closed; coordinator already treats this as idempotent */ }
    }
    async tryInject(tabId) {
        if (this.injected.has(tabId))
            return true;
        try {
            const tab = await chrome.tabs.get(tabId);
            if (!tab.url || RESTRICTED_PREFIXES.some(p => tab.url.startsWith(p)))
                return false;
            await chrome.scripting.executeScript({ target: { tabId }, files: ['hitl-overlay.js'] });
            this.injected.add(tabId);
            return true;
        }
        catch (e) {
            console.warn('[oweibo-hitl] overlay inject failed:', e.message);
            return false;
        }
    }
    forget(tabId) { this.injected.delete(tabId); }
}


/***/ },

/***/ "./src/shared/actions.ts"
/*!*******************************!*\
  !*** ./src/shared/actions.ts ***!
  \*******************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   COOKIE_ACTIONS: () => (/* binding */ COOKIE_ACTIONS),
/* harmony export */   DEBUGGER_ACTIONS: () => (/* binding */ DEBUGGER_ACTIONS),
/* harmony export */   routeFor: () => (/* binding */ routeFor)
/* harmony export */ });
// packages/browser-extension/src/shared/actions.ts
// Local mirror of the BrowserAction discriminated union and HITLGate used
// inside the extension. Intentionally duplicated (rather than imported from
// @oweibo/core-contracts) so the extension build has no cross-package deps
// and can be bundled into a single service-worker file.
//
// Canonical sources in core-contracts/src/browser.ts — keep in sync.
/** 13 page-level actions that still require chrome.debugger / CDP. */
const DEBUGGER_ACTIONS = new Set([
    'navigate', 'screenshot', 'eval', 'accessibility-snapshot',
    'switch-to-frame', 'handle-dialog', 'intercept-request', 'mock-response', 'remove-intercept',
    'log-capture-start', 'log-capture-stop', 'key-chord',
    'record-video-start', 'record-video-stop', 'har-start', 'har-stop',
]);
/** Cookie actions routed through the chrome.cookies API directly. */
const COOKIE_ACTIONS = new Set([
    'clear-cookies', 'get-cookies', 'set-cookies', 'import-cookies',
]);
function routeFor(type) {
    if (DEBUGGER_ACTIONS.has(type))
        return 'debugger';
    if (COOKIE_ACTIONS.has(type))
        return 'cookies';
    return 'content';
}


/***/ }

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		if (!(moduleId in __webpack_modules__)) {
/******/ 			delete __webpack_module_cache__[moduleId];
/******/ 			var e = new Error("Cannot find module '" + moduleId + "'");
/******/ 			e.code = 'MODULE_NOT_FOUND';
/******/ 			throw e;
/******/ 		}
/******/ 		__webpack_modules__[moduleId](module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/define property getters */
/******/ 	(() => {
/******/ 		// define getter functions for harmony exports
/******/ 		__webpack_require__.d = (exports, definition) => {
/******/ 			for(var key in definition) {
/******/ 				if(__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
/******/ 					Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 				}
/******/ 			}
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/hasOwnProperty shorthand */
/******/ 	(() => {
/******/ 		__webpack_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop))
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/make namespace object */
/******/ 	(() => {
/******/ 		// define __esModule on exports
/******/ 		__webpack_require__.r = (exports) => {
/******/ 			if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
/******/ 				Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 			}
/******/ 			Object.defineProperty(exports, '__esModule', { value: true });
/******/ 		};
/******/ 	})();
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};
// This entry needs to be wrapped in an IIFE because it needs to be isolated against other modules in the chunk.
(() => {
/*!***************************!*\
  !*** ./src/background.ts ***!
  \***************************/
__webpack_require__.r(__webpack_exports__);
/* harmony import */ var _bridge_NativeMessagingBridge_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./bridge/NativeMessagingBridge.js */ "./src/bridge/NativeMessagingBridge.ts");
/* harmony import */ var _bridge_ExtensionBridgeServer_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./bridge/ExtensionBridgeServer.js */ "./src/bridge/ExtensionBridgeServer.ts");
/* harmony import */ var _bridge_ExtensionHITLBridge_js__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ./bridge/ExtensionHITLBridge.js */ "./src/bridge/ExtensionHITLBridge.ts");
/* harmony import */ var _content_ContentScriptActionEngine_js__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! ./content/ContentScriptActionEngine.js */ "./src/content/ContentScriptActionEngine.ts");
/* harmony import */ var _content_DebuggerLifecycleManager_js__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(/*! ./content/DebuggerLifecycleManager.js */ "./src/content/DebuggerLifecycleManager.ts");
/* harmony import */ var _hitl_DesktopNotificationFallback_js__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(/*! ./hitl/DesktopNotificationFallback.js */ "./src/hitl/DesktopNotificationFallback.ts");
/* harmony import */ var _hitl_HITLSurfaceCoordinator_js__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(/*! ./hitl/HITLSurfaceCoordinator.js */ "./src/hitl/HITLSurfaceCoordinator.ts");
/* harmony import */ var _hitl_InTabHITLOverlay_js__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(/*! ./hitl/InTabHITLOverlay.js */ "./src/hitl/InTabHITLOverlay.ts");
/* harmony import */ var _shared_actions_js__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(/*! ./shared/actions.js */ "./src/shared/actions.ts");
// packages/browser-extension/src/background.ts
// MV3 service worker — single entry point for all bridge, action, and HITL
// traffic. Wires together the v9.5.9 components:
//
//   • NativeMessagingBridge       — default transport (chrome.runtime.connectNative)
//   • ExtensionBridgeServer       — legacy WebSocket client (@deprecated, websocket mode)
//   • ExtensionHITLBridge         — single HITL gate authority; delegates to coordinator
//   • ContentScriptActionEngine   — 38 DOM actions via content-script.js (isTrusted: true)
//   • DebuggerLifecycleManager    — lazy attach/detach for 13 page-level CDP ops
//   • HITLSurfaceCoordinator      — fans gates to in-tab overlay + OS notification + popup
//
// The cookie actions (clear/get/set/import) hit chrome.cookies directly.









// ── Component graph ────────────────────────────────────────────────────────────
const nativeBridge = new _bridge_NativeMessagingBridge_js__WEBPACK_IMPORTED_MODULE_0__.NativeMessagingBridge();
const legacyBridge = new _bridge_ExtensionBridgeServer_js__WEBPACK_IMPORTED_MODULE_1__.ExtensionBridgeServer(); // @deprecated — websocket mode only
const contentEngine = new _content_ContentScriptActionEngine_js__WEBPACK_IMPORTED_MODULE_3__.ContentScriptActionEngine();
const debuggerMgr = new _content_DebuggerLifecycleManager_js__WEBPACK_IMPORTED_MODULE_4__.DebuggerLifecycleManager('lazy');
const overlay = new _hitl_InTabHITLOverlay_js__WEBPACK_IMPORTED_MODULE_7__.InTabHITLOverlay();
const notification = new _hitl_DesktopNotificationFallback_js__WEBPACK_IMPORTED_MODULE_5__.DesktopNotificationFallback();
// Sink forwards overlay/popup/notification resolutions back through whichever
// transport is active as an `extension-hitl-respond` action.
const gateSink = {
    async onResolved(r) {
        try {
            if (nativeBridge.isConnected()) {
                await nativeBridge.sendAction(crypto.randomUUID(), {
                    type: 'extension-hitl-respond',
                    gateId: r.gateId,
                    accept: r.accept,
                    promptText: r.promptText,
                });
            }
            else if (legacyBridge.isConnected()) {
                legacyBridge.sendGateResolved(r.gateId, r.accept);
            }
        }
        catch (e) {
            console.warn('[oweibo-hitl] sink send failed:', e.message);
        }
    },
};
const coordinator = new _hitl_HITLSurfaceCoordinator_js__WEBPACK_IMPORTED_MODULE_6__.HITLSurfaceCoordinator(overlay, notification, gateSink);
// HITLBridge encapsulates all gate open/resolve/list logic and badge management.
const hitlBridge = new _bridge_ExtensionHITLBridge_js__WEBPACK_IMPORTED_MODULE_2__.ExtensionHITLBridge({
    coordinator,
    nativeBridge,
    legacyBridge,
});
// ── State ──────────────────────────────────────────────────────────────────────
let sessionToken = null;
const BRIDGE_MODE_KEY = 'extensionBridgeMode';
async function loadPersistedState() {
    const stored = await chrome.storage.local.get(['sessionToken', BRIDGE_MODE_KEY]);
    sessionToken = stored['sessionToken'] ?? null;
    const mode = stored[BRIDGE_MODE_KEY] ?? 'native';
    if (sessionToken && mode === 'native') {
        nativeBridge.connect(sessionToken);
    }
}
// ── Action dispatch ────────────────────────────────────────────────────────────
async function executeAction(tabId, action) {
    const route = (0,_shared_actions_js__WEBPACK_IMPORTED_MODULE_8__.routeFor)(action.type);
    if (route === 'cookies') {
        return executeCookieAction(action);
    }
    if (route === 'debugger') {
        return debuggerMgr.withDebugger(tabId, async () => {
            const cdp = action.cdp;
            if (!cdp)
                throw new Error(`debugger route missing cdp payload for ${action.type}`);
            return chrome.debugger.sendCommand({ tabId }, cdp.method, cdp.params);
        });
    }
    // 38 content-script actions
    const result = await contentEngine.dispatch(tabId, action);
    if (!result.success)
        throw new Error(result.error ?? 'content script failed');
    return result.data;
}
async function executeCookieAction(action) {
    switch (action.type) {
        case 'get-cookies': {
            const domain = action.domain;
            const cookies = await chrome.cookies.getAll(domain ? { domain } : {});
            return cookies;
        }
        case 'clear-cookies': {
            const domain = action.domain;
            const cookies = await chrome.cookies.getAll(domain ? { domain } : {});
            await Promise.all(cookies.map(c => chrome.cookies.remove({
                url: `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path}`,
                name: c.name,
            })));
            return { cleared: cookies.length };
        }
        case 'set-cookies': {
            const list = action.cookies ?? [];
            await Promise.all(list.map(c => chrome.cookies.set(c)));
            return { set: list.length };
        }
        case 'import-cookies': {
            const domain = action.domain;
            return chrome.cookies.getAll({ domain });
        }
        default:
            throw new Error(`unsupported cookie action: ${action.type}`);
    }
}
// ── Native host message ingress ────────────────────────────────────────────────
nativeBridge.onInboundAction(async (action, tabId) => {
    return executeAction(tabId, action);
});
nativeBridge.onInboundGate(async (gate, tabId) => {
    await hitlBridge.openGate({ gateId: gate.gateId, type: gate.type, message: gate.message }, tabId);
});
// ── Legacy WS bridge: action and gate handlers ────────────────────────────────
legacyBridge.onAction(async (action, callId, tabId) => {
    return executeAction(tabId, action);
});
legacyBridge.onGate(async (gate, tabId) => {
    await hitlBridge.openGate(gate, tabId);
});
// ── Runtime messages (overlay → background, popup → background) ───────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // Overlay resolution.
    if (msg.__oweiboHitlResolve && msg.gateId) {
        void hitlBridge.resolveGate({
            gateId: msg.gateId,
            accept: Boolean(msg.accept),
            promptText: msg.promptText,
            resolvedBy: 'overlay',
        });
        sendResponse({ ok: true });
        return false;
    }
    // Deep-link pairing (from pair.html).
    if (msg.cmd === 'pair-deeplink' && msg.pairToken) {
        sessionToken = msg.pairToken;
        void chrome.storage.local.set({ sessionToken, [BRIDGE_MODE_KEY]: 'native' }).then(() => {
            nativeBridge.connect(msg.pairToken);
            sendResponse({ ok: true });
        });
        return true;
    }
    // Popup gate resolution.
    if (msg.cmd === 'hitl-resolve' && msg.gateId) {
        void hitlBridge.handlePopupResolve(msg.gateId, Boolean(msg.accept), msg.promptText);
        sendResponse({ ok: true });
        return false;
    }
    // Debug / test hook: open a gate on a tab.
    if (msg.cmd === 'hitl-open' && msg.gate && typeof msg.tabId === 'number') {
        void hitlBridge.openGate(msg.gate, msg.tabId).then(() => sendResponse({ ok: true }));
        return true;
    }
    // Popup — list pending gates.
    if (msg.cmd === 'hitl-list') {
        sendResponse({ ok: true, gates: hitlBridge.listPending() });
        return false;
    }
    // Legacy websocket connect (retained, @deprecated).
    if (msg.cmd === 'connect' && msg.host) {
        void legacyBridge.connect(msg.host).then(() => sendResponse({ ok: true }));
        return true;
    }
    return false;
});
// ── Tab lifecycle: drop cached injection state ─────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
    contentEngine.forget(tabId);
    overlay.forget(tabId);
    void debuggerMgr.detach(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
        contentEngine.forget(tabId);
        overlay.forget(tabId);
    }
});
void loadPersistedState();
// Exported for tests / popup inspection via globalThis in the SW scope.
self.__oweibo = {
    nativeBridge, legacyBridge, hitlBridge, contentEngine, debuggerMgr, coordinator,
    executeAction,
};

})();

/******/ })()
;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,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LEVBQUUsRUFBRTtJQUN0RCxJQUFJLFVBQVUsQ0FBQyxNQUFNLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDcEMsYUFBYSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUM1QixPQUFPLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQ3hCLENBQUM7QUFDSCxDQUFDLENBQUMsQ0FBQztBQUVILEtBQUssa0JBQWtCLEVBQUUsQ0FBQztBQUUxQix3RUFBd0U7QUFDdkUsSUFBMEMsQ0FBQyxRQUFRLEdBQUc7SUFDckQsWUFBWSxFQUFFLFlBQVksRUFBRSxVQUFVLEVBQUUsYUFBYSxFQUFFLFdBQVcsRUFBRSxXQUFXO0lBQy9FLGFBQWE7Q0FDZCxDQUFDIiwic291cmNlcyI6WyJ3ZWJwYWNrOi8vQG93ZWliby9icm93c2VyLWV4dGVuc2lvbi8uL3NyYy9icmlkZ2UvRXh0ZW5zaW9uQnJpZGdlU2VydmVyLnRzIiwid2VicGFjazovL0Bvd2VpYm8vYnJvd3Nlci1leHRlbnNpb24vLi9zcmMvYnJpZGdlL0V4dGVuc2lvbkhJVExCcmlkZ2UudHMiLCJ3ZWJwYWNrOi8vQG93ZWliby9icm93c2VyLWV4dGVuc2lvbi8uL3NyYy9icmlkZ2UvTmF0aXZlTWVzc2FnaW5nQnJpZGdlLnRzIiwid2VicGFjazovL0Bvd2VpYm8vYnJvd3Nlci1leHRlbnNpb24vLi9zcmMvY29udGVudC9Db250ZW50U2NyaXB0QWN0aW9uRW5naW5lLnRzIiwid2VicGFjazovL0Bvd2VpYm8vYnJvd3Nlci1leHRlbnNpb24vLi9zcmMvY29udGVudC9EZWJ1Z2dlckxpZmVjeWNsZU1hbmFnZXIudHMiLCJ3ZWJwYWNrOi8vQG93ZWliby9icm93c2VyLWV4dGVuc2lvbi8uL3NyYy9oaXRsL0Rlc2t0b3BOb3RpZmljYXRpb25GYWxsYmFjay50cyIsIndlYnBhY2s6Ly9Ab3dlaWJvL2Jyb3dzZXItZXh0ZW5zaW9uLy4vc3JjL2hpdGwvSElUTFN1cmZhY2VDb29yZGluYXRvci50cyIsIndlYnBhY2s6Ly9Ab3dlaWJvL2Jyb3dzZXItZXh0ZW5zaW9uLy4vc3JjL2hpdGwvSW5UYWJISVRMT3ZlcmxheS50cyIsIndlYnBhY2s6Ly9Ab3dlaWJvL2Jyb3dzZXItZXh0ZW5zaW9uLy4vc3JjL3NoYXJlZC9hY3Rpb25zLnRzIiwid2VicGFjazovL0Bvd2VpYm8vYnJvd3Nlci1leHRlbnNpb24vd2VicGFjay9ib290c3RyYXAiLCJ3ZWJwYWNrOi8vQG93ZWliby9icm93c2VyLWV4dGVuc2lvbi93ZWJwYWNrL3J1bnRpbWUvZGVmaW5lIHByb3BlcnR5IGdldHRlcnMiLCJ3ZWJwYWNrOi8vQG93ZWliby9icm93c2VyLWV4dGVuc2lvbi93ZWJwYWNrL3J1bnRpbWUvaGFzT3duUHJvcGVydHkgc2hvcnRoYW5kIiwid2VicGFjazovL0Bvd2VpYm8vYnJvd3Nlci1leHRlbnNpb24vd2VicGFjay9ydW50aW1lL21ha2UgbmFtZXNwYWNlIG9iamVjdCIsIndlYnBhY2s6Ly9Ab3dlaWJvL2Jyb3dzZXItZXh0ZW5zaW9uLy4vc3JjL2JhY2tncm91bmQudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gcGFja2FnZXMvYnJvd3Nlci1leHRlbnNpb24vc3JjL2JyaWRnZS9FeHRlbnNpb25CcmlkZ2VTZXJ2ZXIudHNcbi8vIEBkZXByZWNhdGVkIOKAlCBMZWdhY3kgV2ViU29ja2V0IHRyYW5zcG9ydCByZXRhaW5lZCBmb3IgZXh0ZW5zaW9uQnJpZGdlTW9kZTond2Vic29ja2V0Jy5cbi8vICAgICAgICAgICAgICBEZWZhdWx0IHRyYW5zcG9ydCBpbiB2OS41LjkgaXMgTmF0aXZlTWVzc2FnaW5nQnJpZGdlIChzdGRpbyBwaXBlKS5cbi8vXG4vLyBFeHRlbnNpb24tc2lkZSBXZWJTb2NrZXQgY2xpZW50IHRoYXQgY29ubmVjdHMgdG8gdGhlIE5vZGUuanNcbi8vIEV4dGVuc2lvbkJyaWRnZVNlcnZlciBydW5uaW5nIGluIGJyb3dzZXItdG9vbC9zcmMvc2Vzc2lvbi8uIEVuY2Fwc3VsYXRlc1xuLy8gdGhlIGJyb3dzZXIgV2ViU29ja2V0IEFQSSB1c2VkIGluc2lkZSB0aGUgTVYzIHNlcnZpY2Ugd29ya2VyLlxuLy9cbi8vIFRoZSBzZXJ2ZXIgc2lkZSAoTm9kZS5qcyB3cyBwYWNrYWdlKSBsaXZlcyBpbiBicm93c2VyLXRvb2wvc3JjL3Nlc3Npb24vRXh0ZW5zaW9uQnJpZGdlU2VydmVyLnRzLlxuXG5pbXBvcnQgdHlwZSB7IEJyb3dzZXJBY3Rpb24sIEhJVExHYXRlIH0gZnJvbSAnLi4vc2hhcmVkL2FjdGlvbnMuanMnO1xuXG5leHBvcnQgdHlwZSBMZWdhY3lNZXNzYWdlSGFuZGxlciA9IChhY3Rpb246IEJyb3dzZXJBY3Rpb24sIGNhbGxJZDogc3RyaW5nLCB0YWJJZDogbnVtYmVyKSA9PiBQcm9taXNlPHVua25vd24+O1xuZXhwb3J0IHR5cGUgTGVnYWN5R2F0ZUhhbmRsZXIgICAgPSAoZ2F0ZTogSElUTEdhdGUsIHRhYklkOiBudW1iZXIpID0+IFByb21pc2U8dm9pZD47XG5cbi8qKiBAZGVwcmVjYXRlZCBVc2UgTmF0aXZlTWVzc2FnaW5nQnJpZGdlIGluc3RlYWQuICovXG5leHBvcnQgY2xhc3MgRXh0ZW5zaW9uQnJpZGdlU2VydmVyIHtcbiAgcHJpdmF0ZSB3czogV2ViU29ja2V0IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgYWN0aW9uSGFuZGxlcjogTGVnYWN5TWVzc2FnZUhhbmRsZXIgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBnYXRlSGFuZGxlcjogICBMZWdhY3lHYXRlSGFuZGxlciAgICB8IG51bGwgPSBudWxsO1xuXG4gIG9uQWN0aW9uKGhhbmRsZXI6IExlZ2FjeU1lc3NhZ2VIYW5kbGVyKTogdm9pZCB7IHRoaXMuYWN0aW9uSGFuZGxlciA9IGhhbmRsZXI7IH1cbiAgb25HYXRlKGhhbmRsZXI6IExlZ2FjeUdhdGVIYW5kbGVyKTogICAgIHZvaWQgeyB0aGlzLmdhdGVIYW5kbGVyICAgPSBoYW5kbGVyOyB9XG5cbiAgaXNDb25uZWN0ZWQoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMud3MgIT09IG51bGwgJiYgdGhpcy53cy5yZWFkeVN0YXRlID09PSBXZWJTb2NrZXQuT1BFTjtcbiAgfVxuXG4gIGNvbm5lY3QoaG9zdDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHRoaXMuaXNDb25uZWN0ZWQoKSkgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHdzID0gbmV3IFdlYlNvY2tldChob3N0KTtcbiAgICAgIHdzLm9ub3BlbiAgICA9ICgpID0+IHsgdGhpcy53cyA9IHdzOyByZXNvbHZlKCk7IH07XG4gICAgICB3cy5vbmNsb3NlICAgPSAoKSA9PiB7IHRoaXMud3MgPSBudWxsOyB9O1xuICAgICAgd3Mub25lcnJvciAgID0gKGUpID0+IHsgcmVqZWN0KG5ldyBFcnJvcihgW293ZWliby1icmlkZ2UtbGVnYWN5XSB3cyBlcnJvcjogJHtTdHJpbmcoZSl9YCkpOyB9O1xuICAgICAgd3Mub25tZXNzYWdlID0gKGV2KSA9PiB7IHZvaWQgdGhpcy5oYW5kbGVNZXNzYWdlKGV2LmRhdGEgYXMgc3RyaW5nKTsgfTtcbiAgICB9KTtcbiAgfVxuXG4gIGRpc2Nvbm5lY3QoKTogdm9pZCB7XG4gICAgdGhpcy53cz8uY2xvc2UoKTtcbiAgICB0aGlzLndzID0gbnVsbDtcbiAgfVxuXG4gIC8qKiBTZW5kIGFuIGFjdGlvbiByZXN1bHQgYmFjayB0byB0aGUgTm9kZS5qcyBzZXJ2ZXIuICovXG4gIHNlbmRSZXN1bHQoY2FsbElkOiBzdHJpbmcsIHJlc3VsdDogdW5rbm93biwgZXJyb3I/OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuaXNDb25uZWN0ZWQoKSkgcmV0dXJuO1xuICAgIHRoaXMud3MhLnNlbmQoSlNPTi5zdHJpbmdpZnkoeyBraW5kOiAnYWN0aW9uLXJlc3VsdCcsIGNhbGxJZCwgcmVzdWx0LCBlcnJvciB9KSk7XG4gIH1cblxuICAvKiogU2VuZCBhIGdhdGUtcmVzb2x2ZWQgbm90aWZpY2F0aW9uIGJhY2sgdG8gdGhlIHNlcnZlci4gKi9cbiAgc2VuZEdhdGVSZXNvbHZlZChnYXRlSWQ6IHN0cmluZywgYWNjZXB0OiBib29sZWFuKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmlzQ29ubmVjdGVkKCkpIHJldHVybjtcbiAgICB0aGlzLndzIS5zZW5kKEpTT04uc3RyaW5naWZ5KHsga2luZDogJ2hpdGwtcmVzb2x2ZScsIGdhdGVJZCwgYWNjZXB0IH0pKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgaGFuZGxlTWVzc2FnZShyYXc6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGxldCBtc2c6IHVua25vd247XG4gICAgdHJ5IHsgbXNnID0gSlNPTi5wYXJzZShyYXcpOyB9XG4gICAgY2F0Y2ggeyBjb25zb2xlLmVycm9yKCdbb3dlaWJvLWJyaWRnZS1sZWdhY3ldIHVucGFyc2VhYmxlIG1lc3NhZ2UnKTsgcmV0dXJuOyB9XG5cbiAgICBjb25zdCBtID0gbXNnIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuXG4gICAgaWYgKG1bJ2tpbmQnXSA9PT0gJ2FjdGlvbicgJiYgdHlwZW9mIG1bJ2NhbGxJZCddID09PSAnc3RyaW5nJykge1xuICAgICAgY29uc3QgY2FsbElkID0gbVsnY2FsbElkJ10gYXMgc3RyaW5nO1xuICAgICAgY29uc3QgdGFiSWQgID0gKG1bJ3RhYklkJ10gYXMgbnVtYmVyIHwgdW5kZWZpbmVkKSA/PyAwO1xuICAgICAgY29uc3QgYWN0aW9uID0gbVsnYWN0aW9uJ10gYXMgQnJvd3NlckFjdGlvbjtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMuYWN0aW9uSGFuZGxlcj8uKGFjdGlvbiwgY2FsbElkLCB0YWJJZCk7XG4gICAgICAgIHRoaXMuc2VuZFJlc3VsdChjYWxsSWQsIHJlc3VsdCk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIHRoaXMuc2VuZFJlc3VsdChjYWxsSWQsIG51bGwsIChlIGFzIEVycm9yKS5tZXNzYWdlKTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAobVsna2luZCddID09PSAnaGl0bC1vcGVuJyAmJiBtWydnYXRlJ10pIHtcbiAgICAgIGNvbnN0IGdhdGUgID0gbVsnZ2F0ZSddIGFzIEhJVExHYXRlO1xuICAgICAgY29uc3QgdGFiSWQgPSAobVsndGFiSWQnXSBhcyBudW1iZXIgfCB1bmRlZmluZWQpID8/IDA7XG4gICAgICB0cnkgeyBhd2FpdCB0aGlzLmdhdGVIYW5kbGVyPy4oZ2F0ZSwgdGFiSWQpOyB9XG4gICAgICBjYXRjaCAoZSkgeyBjb25zb2xlLmVycm9yKCdbb3dlaWJvLWJyaWRnZS1sZWdhY3ldIGdhdGUgaGFuZGxlciBlcnJvcjonLCAoZSBhcyBFcnJvcikubWVzc2FnZSk7IH1cbiAgICAgIHJldHVybjtcbiAgICB9XG4gIH1cbn1cbiIsIi8vIHBhY2thZ2VzL2Jyb3dzZXItZXh0ZW5zaW9uL3NyYy9icmlkZ2UvRXh0ZW5zaW9uSElUTEJyaWRnZS50c1xuLy8gU2luZ2xlIHBvaW50IG9mIGVudHJ5IGZvciBhbGwgSElUTCAoaHVtYW4taW4tdGhlLWxvb3ApIGdhdGUgbGlmZWN5Y2xlIGV2ZW50c1xuLy8gZmxvd2luZyBiZXR3ZWVuIHRoZSBwaXBlbGluZSBhbmQgdGhlIHRocmVlIHVzZXItZmFjaW5nIHN1cmZhY2VzOlxuLy8gICAxLiBFeHRlbnNpb24gcG9wdXAgZ2F0ZSBjYXJkXG4vLyAgIDIuIEluVGFiSElUTE92ZXJsYXkgKGZsb2F0aW5nIHBhbmVsIGluamVjdGVkIGludG8gdGhlIGFjdGl2ZSB0YWIpXG4vLyAgIDMuIERlc2t0b3BOb3RpZmljYXRpb25GYWxsYmFjayAoT1Mgbm90aWZpY2F0aW9uIHdoZW4gdGFiIGlzIGJhY2tncm91bmRlZClcbi8vXG4vLyBEZWxlZ2F0ZXMgZ2F0ZSByZWdpc3RyYXRpb24gYW5kIHJlc29sdXRpb24gdG8gSElUTFN1cmZhY2VDb29yZGluYXRvciwgd2hpY2hcbi8vIG93bnMgdGhlIGZpcnN0LXJlc3BvbnNlLXdpbnMgc2VtYW50aWNzLiBUaGUgcG9wdXAgcGF0aCBhbmQgYmFkZ2UgdXBkYXRlcyBhcmVcbi8vIGFsc28gbWFuYWdlZCBoZXJlIHNvIGJhY2tncm91bmQudHMgc3RheXMgdGhpbi5cbi8vXG4vLyB2OS41Ljkg4oCUIHJlcGxhY2VzIHRoZSBpbmxpbmUgZ2F0ZSBoYW5kbGluZyB0aGF0IHdhcyBwcmV2aW91c2x5IHNjYXR0ZXJlZFxuLy8gICAgICAgICAgIGFjcm9zcyBiYWNrZ3JvdW5kLnRzLlxuXG5pbXBvcnQgdHlwZSB7IEdhdGVSZXNvbHV0aW9uLCBISVRMR2F0ZSB9IGZyb20gJy4uL3NoYXJlZC9hY3Rpb25zLmpzJztcbmltcG9ydCB0eXBlIHsgSElUTFN1cmZhY2VDb29yZGluYXRvciB9IGZyb20gJy4uL2hpdGwvSElUTFN1cmZhY2VDb29yZGluYXRvci5qcyc7XG5pbXBvcnQgdHlwZSB7IE5hdGl2ZU1lc3NhZ2luZ0JyaWRnZSB9IGZyb20gJy4vTmF0aXZlTWVzc2FnaW5nQnJpZGdlLmpzJztcbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQnJpZGdlU2VydmVyIH0gZnJvbSAnLi9FeHRlbnNpb25CcmlkZ2VTZXJ2ZXIuanMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEV4dGVuc2lvbkhJVExCcmlkZ2VEZXBzIHtcbiAgY29vcmRpbmF0b3I6ICAgIEhJVExTdXJmYWNlQ29vcmRpbmF0b3I7XG4gIG5hdGl2ZUJyaWRnZTogICBOYXRpdmVNZXNzYWdpbmdCcmlkZ2U7XG4gIC8qKiBPcHRpb25hbCBsZWdhY3kgV1MgYnJpZGdlIOKAlCBwcmVzZW50IG9ubHkgaW4gZXh0ZW5zaW9uQnJpZGdlTW9kZTond2Vic29ja2V0Jy4gKi9cbiAgbGVnYWN5QnJpZGdlPzogIEV4dGVuc2lvbkJyaWRnZVNlcnZlcjtcbn1cblxuZXhwb3J0IGNsYXNzIEV4dGVuc2lvbkhJVExCcmlkZ2Uge1xuICBwcml2YXRlIHJlYWRvbmx5IGNvb3JkaW5hdG9yOiBISVRMU3VyZmFjZUNvb3JkaW5hdG9yO1xuICBwcml2YXRlIHJlYWRvbmx5IG5hdGl2ZTogICAgICBOYXRpdmVNZXNzYWdpbmdCcmlkZ2U7XG4gIHByaXZhdGUgcmVhZG9ubHkgbGVnYWN5PzogICAgIEV4dGVuc2lvbkJyaWRnZVNlcnZlcjtcblxuICBjb25zdHJ1Y3RvcihkZXBzOiBFeHRlbnNpb25ISVRMQnJpZGdlRGVwcykge1xuICAgIHRoaXMuY29vcmRpbmF0b3IgPSBkZXBzLmNvb3JkaW5hdG9yO1xuICAgIHRoaXMubmF0aXZlICAgICAgPSBkZXBzLm5hdGl2ZUJyaWRnZTtcbiAgICB0aGlzLmxlZ2FjeSAgICAgID0gZGVwcy5sZWdhY3lCcmlkZ2U7XG4gIH1cblxuICAvKipcbiAgICogT3BlbiBhIEhJVEwgZ2F0ZTogZmFuIG91dCB0byBpbi10YWIgb3ZlcmxheSwgT1Mgbm90aWZpY2F0aW9uLCBhbmQgcG9wdXBcbiAgICogc2ltdWx0YW5lb3VzbHkgdmlhIEhJVExTdXJmYWNlQ29vcmRpbmF0b3IuXG4gICAqL1xuICBhc3luYyBvcGVuR2F0ZShnYXRlOiBISVRMR2F0ZSwgdGFiSWQ6IG51bWJlcik6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IHRoaXMuY29vcmRpbmF0b3Iub3BlbihnYXRlLCB0YWJJZCk7XG4gICAgLy8gTm90aWZ5IHBvcHVwIChmaXJlLWFuZC1mb3JnZXQ7IHBvcHVwIG1heSBub3QgYmUgb3BlbilcbiAgICB0aGlzLnNlbmRUb1BvcHVwKHsgdHlwZTogJ2hpdGwtZ2F0ZScsIGdhdGUgfSk7XG4gIH1cblxuICAvKipcbiAgICogUmVzb2x2ZSBhIGdhdGUg4oCUIGlkZW1wb3RlbnQuIENhbGxlZCBieSBhbnkgc3VyZmFjZSAob3ZlcmxheSwgbm90aWZpY2F0aW9uLFxuICAgKiBwb3B1cCkgdGhhdCB3aW5zIHRoZSBmaXJzdC1yZXNwb25zZSByYWNlLlxuICAgKiBGb3J3YXJkcyB0aGUgcmVzb2x2ZWQgZ2F0ZSBiYWNrIHRvIHRoZSBwaXBlbGluZSB2aWEgd2hpY2hldmVyIHRyYW5zcG9ydCBpcyBhY3RpdmUuXG4gICAqL1xuICBhc3luYyByZXNvbHZlR2F0ZShyZXNvbHV0aW9uOiBHYXRlUmVzb2x1dGlvbik6IFByb21pc2U8dm9pZD4ge1xuICAgIC8vIGNvb3JkaW5hdG9yLnJlc29sdmUoKSBpcyBpZGVtcG90ZW50OyBzdWJzZXF1ZW50IGNhbGxzIGFyZSBuby1vcHMuXG4gICAgYXdhaXQgdGhpcy5jb29yZGluYXRvci5yZXNvbHZlKHJlc29sdXRpb24pO1xuICAgIHRoaXMuc2VuZFRvUG9wdXAoeyB0eXBlOiAnaGl0bC1kaXNtaXNzJywgZ2F0ZUlkOiByZXNvbHV0aW9uLmdhdGVJZCB9KTtcbiAgICB0aGlzLnVwZGF0ZUJhZGdlKCk7XG4gIH1cblxuICAvKipcbiAgICogQ2FsbGVkIGJ5IGJhY2tncm91bmQudHMgd2hlbiBhIGNocm9tZS5ydW50aW1lLm9uTWVzc2FnZSBhcnJpdmVzIGZyb20gdGhlXG4gICAqIHBvcHVwIGNhcnJ5aW5nIGEgcmVzb2x1dGlvbi5cbiAgICovXG4gIGFzeW5jIGhhbmRsZVBvcHVwUmVzb2x2ZShnYXRlSWQ6IHN0cmluZywgYWNjZXB0OiBib29sZWFuLCBwcm9tcHRUZXh0Pzogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYXdhaXQgdGhpcy5yZXNvbHZlR2F0ZSh7IGdhdGVJZCwgYWNjZXB0LCBwcm9tcHRUZXh0LCByZXNvbHZlZEJ5OiAncG9wdXAnIH0pO1xuICB9XG5cbiAgLyoqIExpc3QgYWxsIHBlbmRpbmcgZ2F0ZXMgZm9yIHRoZSBwb3B1cCB0byByZW5kZXIuICovXG4gIGxpc3RQZW5kaW5nKCk6IEhJVExHYXRlW10ge1xuICAgIHJldHVybiB0aGlzLmNvb3JkaW5hdG9yLmxpc3RQZW5kaW5nKCk7XG4gIH1cblxuICBwZW5kaW5nQ291bnQoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy5jb29yZGluYXRvci5wZW5kaW5nQ291bnQoKTtcbiAgfVxuXG4gIC8vIOKUgOKUgOKUgCBQcml2YXRlIGhlbHBlcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgcHJpdmF0ZSBzZW5kVG9Qb3B1cChtZXNzYWdlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IHZvaWQge1xuICAgIHRyeSB7XG4gICAgICB2b2lkIGNocm9tZS5ydW50aW1lLnNlbmRNZXNzYWdlKG1lc3NhZ2UpLmNhdGNoKCgpID0+IHtcbiAgICAgICAgLy8gUG9wdXAgbm90IG9wZW4g4oCUIHN1cHByZXNzIHRoZSBlcnJvci5cbiAgICAgIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gU2VydmljZSB3b3JrZXIgY29udGV4dCBtYXkgcmVqZWN0IGNocm9tZS5ydW50aW1lLnNlbmRNZXNzYWdlIGlmIHRoZXJlIGFyZVxuICAgICAgLy8gbm8gbGlzdGVuZXJzLiBTaWxlbmNlIGl0LlxuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgdXBkYXRlQmFkZ2UoKTogdm9pZCB7XG4gICAgY29uc3QgbiA9IHRoaXMuY29vcmRpbmF0b3IucGVuZGluZ0NvdW50KCk7XG4gICAgdHJ5IHtcbiAgICAgIHZvaWQgY2hyb21lLmFjdGlvbi5zZXRCYWRnZVRleHQoeyB0ZXh0OiBuID4gMCA/IFN0cmluZyhuKSA6ICcnIH0pO1xuICAgICAgdm9pZCBjaHJvbWUuYWN0aW9uLnNldEJhZGdlQmFja2dyb3VuZENvbG9yKHsgY29sb3I6ICcjZDA0YTRhJyB9KTtcbiAgICB9IGNhdGNoIHsgLyogTVYzIHdvcmtlciBtYXkgYmUgc3RhcnRpbmcgKi8gfVxuICB9XG59XG4iLCIvLyBwYWNrYWdlcy9icm93c2VyLWV4dGVuc2lvbi9zcmMvYnJpZGdlL05hdGl2ZU1lc3NhZ2luZ0JyaWRnZS50c1xuLy8gRGVmYXVsdCB0cmFuc3BvcnQgaW4gdjkuNS45LiBSZXBsYWNlcyBFeHRlbnNpb25CcmlkZ2VTZXJ2ZXIgV2ViU29ja2V0IHdpdGhcbi8vIENocm9tZS1tYW5hZ2VkIHN0ZGlvIHZpYSBjaHJvbWUucnVudGltZS5jb25uZWN0TmF0aXZlLiBTYW1lIEhNQUMtcGVyLW1lc3NhZ2Vcbi8vIGF1dGhlbnRpY2F0aW9uIHNjaGVtZTsgbm8gcG9ydCBiaW5kaW5nOyBubyBzZXBhcmF0ZSBzZXJ2ZXIgcHJvY2Vzcy5cblxuaW1wb3J0IHR5cGUgeyBCcm93c2VyQWN0aW9uIH0gZnJvbSAnLi4vc2hhcmVkL2FjdGlvbnMuanMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIE5hdGl2ZU1lc3NhZ2Uge1xuICBjYWxsSWQ6IHN0cmluZztcbiAgLyoqIFdoZW4gcHJlc2VudDogaG9zdOKGkmV4dGVuc2lvbiBjb21tYW5kIChpbmJvdW5kKS4gKi9cbiAgYWN0aW9uPzogQnJvd3NlckFjdGlvbjtcbiAgLyoqIFRhcmdldCB0YWIgZm9yIGluYm91bmQgYWN0aW9ucy4gKi9cbiAgdGFiSWQ/OiBudW1iZXI7XG4gIC8qKiBHYXRlIHBheWxvYWQgd2hlbiB0aGUgaG9zdCBhc2tzIHRoZSBleHRlbnNpb24gdG8gb3BlbiBhIEhJVEwgc3VyZmFjZS4gKi9cbiAgZ2F0ZT86IHsgZ2F0ZUlkOiBzdHJpbmc7IHR5cGU6ICdkaWFsb2cnIHwgJ3Zpc2lvbi1sb29wJzsgbWVzc2FnZTogc3RyaW5nIH07XG4gIC8qKiBXaGVuIHByZXNlbnQ6IHJlcGx5IHRvIGEgcHJpb3IgZXh0ZW5zaW9u4oaSaG9zdCBjYWxsIChvdXRib3VuZCByZXNwb25zZSkuICovXG4gIHJlc3VsdD86IHVua25vd247XG4gIGVycm9yPzogIHN0cmluZztcbiAgLyoqIERpc2NyaW1pbmF0b3Igc28gdGhlIGV4dGVuc2lvbiBrbm93cyB3aGV0aGVyIHRvIGRpc3BhdGNoIG9yIHJlc29sdmUuICovXG4gIGRpcmVjdGlvbj86ICdyZXF1ZXN0JyB8ICdyZXNwb25zZSc7XG4gIGhtYWM/OiAgIHN0cmluZztcbn1cblxuLyoqIEhhbmRsZXIgdGhhdCBleGVjdXRlcyBhbiBpbmJvdW5kIGFjdGlvbiBhbmQgcmV0dXJucyBpdHMgSlNPTi1zZXJpYWxpc2FibGUgcmVzdWx0LiAqL1xuZXhwb3J0IHR5cGUgSW5ib3VuZEFjdGlvbkhhbmRsZXIgPSAoXG4gIGFjdGlvbjogQnJvd3NlckFjdGlvbixcbiAgdGFiSWQ6IG51bWJlcixcbikgPT4gUHJvbWlzZTx1bmtub3duPjtcblxuLyoqIEhhbmRsZXIgaW52b2tlZCB3aGVuIHRoZSBob3N0IGFza3MgdGhlIGV4dGVuc2lvbiB0byBvcGVuIGEgSElUTCBnYXRlIHN1cmZhY2UuICovXG5leHBvcnQgdHlwZSBJbmJvdW5kR2F0ZUhhbmRsZXIgPSAoXG4gIGdhdGU6IHsgZ2F0ZUlkOiBzdHJpbmc7IHR5cGU6ICdkaWFsb2cnIHwgJ3Zpc2lvbi1sb29wJzsgbWVzc2FnZTogc3RyaW5nIH0sXG4gIHRhYklkOiBudW1iZXIsXG4pID0+IFByb21pc2U8dm9pZD47XG5cbnR5cGUgUmVzb2x2ZXIgPSAocjogdW5rbm93bikgPT4gdm9pZDtcbnR5cGUgUmVqZWN0b3IgPSAoZXJyOiBFcnJvcikgPT4gdm9pZDtcblxuY29uc3QgTkFUSVZFX0hPU1RfTkFNRSA9ICdjb20ub3dlaWJvLmJyb3dzZXInO1xuXG4vKiogU3VidGxlLWNyeXB0byBITUFDLVNIQTI1NiBvdmVyIHRoZSBjYW5vbmljYWwgSlNPTiBvZiAoY2FsbElkICsgYWN0aW9ufHJlc3VsdCkuICovXG5hc3luYyBmdW5jdGlvbiBjb21wdXRlSG1hYyhrZXk6IHN0cmluZywgcGF5bG9hZDogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3QgZW5jID0gbmV3IFRleHRFbmNvZGVyKCk7XG4gIGNvbnN0IGNyeXB0b0tleSA9IGF3YWl0IGNyeXB0by5zdWJ0bGUuaW1wb3J0S2V5KFxuICAgICdyYXcnLCBlbmMuZW5jb2RlKGtleSksIHsgbmFtZTogJ0hNQUMnLCBoYXNoOiAnU0hBLTI1NicgfSwgZmFsc2UsIFsnc2lnbicsICd2ZXJpZnknXSxcbiAgKTtcbiAgY29uc3Qgc2lnID0gYXdhaXQgY3J5cHRvLnN1YnRsZS5zaWduKCdITUFDJywgY3J5cHRvS2V5LCBlbmMuZW5jb2RlKHBheWxvYWQpKTtcbiAgcmV0dXJuIGJ0b2EoU3RyaW5nLmZyb21DaGFyQ29kZSguLi5uZXcgVWludDhBcnJheShzaWcpKSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHZlcmlmeUhtYWMobXNnOiBOYXRpdmVNZXNzYWdlLCBrZXk6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBpZiAoIW1zZy5obWFjKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IHsgaG1hYzogX2gsIC4uLnJlc3QgfSA9IG1zZztcbiAgY29uc3QgZXhwZWN0ZWQgPSBhd2FpdCBjb21wdXRlSG1hYyhrZXksIEpTT04uc3RyaW5naWZ5KHJlc3QpKTtcbiAgcmV0dXJuIGV4cGVjdGVkID09PSBtc2cuaG1hYztcbn1cblxuZXhwb3J0IGNsYXNzIE5hdGl2ZU1lc3NhZ2luZ0JyaWRnZSB7XG4gIHByaXZhdGUgcG9ydDogY2hyb21lLnJ1bnRpbWUuUG9ydCB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHJlYWRvbmx5IHBlbmRpbmcgPSBuZXcgTWFwPHN0cmluZywgeyByZXNvbHZlOiBSZXNvbHZlcjsgcmVqZWN0OiBSZWplY3RvciB9PigpO1xuICBwcml2YXRlIGhtYWNUb2tlbiA9ICcnO1xuICBwcml2YXRlIGluYm91bmRBY3Rpb246IEluYm91bmRBY3Rpb25IYW5kbGVyIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgaW5ib3VuZEdhdGU6ICAgSW5ib3VuZEdhdGVIYW5kbGVyICAgfCBudWxsID0gbnVsbDtcblxuICAvKiogUmVnaXN0ZXIgdGhlIGZ1bmN0aW9uIHRoYXQgcnVucyBob3N0LWluaXRpYXRlZCBhY3Rpb25zIGFnYWluc3QgdGhlIGJyb3dzZXIuICovXG4gIG9uSW5ib3VuZEFjdGlvbihoYW5kbGVyOiBJbmJvdW5kQWN0aW9uSGFuZGxlcik6IHZvaWQgeyB0aGlzLmluYm91bmRBY3Rpb24gPSBoYW5kbGVyOyB9XG5cbiAgLyoqIFJlZ2lzdGVyIHRoZSBmdW5jdGlvbiB0aGF0IG9wZW5zIGEgSElUTCBnYXRlIHN1cmZhY2UgaW4gYSB0YWIuICovXG4gIG9uSW5ib3VuZEdhdGUoaGFuZGxlcjogSW5ib3VuZEdhdGVIYW5kbGVyKTogdm9pZCB7IHRoaXMuaW5ib3VuZEdhdGUgPSBoYW5kbGVyOyB9XG5cbiAgY29ubmVjdChobWFjVG9rZW46IHN0cmluZyk6IHZvaWQge1xuICAgIGlmICh0aGlzLnBvcnQpIHJldHVybjtcbiAgICB0aGlzLmhtYWNUb2tlbiA9IGhtYWNUb2tlbjtcbiAgICB0cnkge1xuICAgICAgdGhpcy5wb3J0ID0gY2hyb21lLnJ1bnRpbWUuY29ubmVjdE5hdGl2ZShOQVRJVkVfSE9TVF9OQU1FKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLmVycm9yKCdbb3dlaWJvLWJyaWRnZV0gbmF0aXZlIGhvc3QgY29ubmVjdCBmYWlsZWQ6JywgZSk7XG4gICAgICB0aGlzLnBvcnQgPSBudWxsO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0aGlzLnBvcnQub25NZXNzYWdlLmFkZExpc3RlbmVyKChtc2c6IE5hdGl2ZU1lc3NhZ2UpID0+IHsgdm9pZCB0aGlzLmhhbmRsZUluY29taW5nKG1zZyk7IH0pO1xuICAgIHRoaXMucG9ydC5vbkRpc2Nvbm5lY3QuYWRkTGlzdGVuZXIoKCkgPT4ge1xuICAgICAgY29uc3QgZXJyID0gY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yPy5tZXNzYWdlID8/ICdkaXNjb25uZWN0ZWQnO1xuICAgICAgY29uc29sZS53YXJuKCdbb3dlaWJvLWJyaWRnZV0gbmF0aXZlIGhvc3QgZGlzY29ubmVjdGVkOicsIGVycik7XG4gICAgICB0aGlzLmZhaWxBbGwobmV3IEVycm9yKGVycikpO1xuICAgICAgdGhpcy5wb3J0ID0gbnVsbDtcbiAgICB9KTtcbiAgfVxuXG4gIGlzQ29ubmVjdGVkKCk6IGJvb2xlYW4geyByZXR1cm4gdGhpcy5wb3J0ICE9PSBudWxsOyB9XG5cbiAgYXN5bmMgc2VuZEFjdGlvbihjYWxsSWQ6IHN0cmluZywgYWN0aW9uOiBCcm93c2VyQWN0aW9uKTogUHJvbWlzZTx1bmtub3duPiB7XG4gICAgaWYgKCF0aGlzLnBvcnQpIHRocm93IG5ldyBFcnJvcignTmF0aXZlTWVzc2FnaW5nQnJpZGdlOiBub3QgY29ubmVjdGVkJyk7XG4gICAgY29uc3QgYm9keTogTmF0aXZlTWVzc2FnZSA9IHsgY2FsbElkLCBhY3Rpb24sIGRpcmVjdGlvbjogJ3JlcXVlc3QnIH07XG4gICAgYm9keS5obWFjID0gYXdhaXQgY29tcHV0ZUhtYWModGhpcy5obWFjVG9rZW4sIHRoaXMuY2Fub25pY2FsaXplKGJvZHkpKTtcbiAgICByZXR1cm4gbmV3IFByb21pc2U8dW5rbm93bj4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgdGhpcy5wZW5kaW5nLnNldChjYWxsSWQsIHsgcmVzb2x2ZSwgcmVqZWN0IH0pO1xuICAgICAgdGhpcy5wb3J0IS5wb3N0TWVzc2FnZShib2R5KTtcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBQb3N0IGEgcmVzcG9uc2UgdG8gYW4gZWFybGllciBpbmJvdW5kIChob3N04oaSZXh0ZW5zaW9uKSByZXF1ZXN0LiAqL1xuICBwcml2YXRlIGFzeW5jIHNlbmRSZXNwb25zZShjYWxsSWQ6IHN0cmluZywgcmVzdWx0OiB1bmtub3duLCBlcnJvcj86IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICghdGhpcy5wb3J0KSByZXR1cm47XG4gICAgY29uc3QgYm9keTogTmF0aXZlTWVzc2FnZSA9IHsgY2FsbElkLCByZXN1bHQsIGVycm9yLCBkaXJlY3Rpb246ICdyZXNwb25zZScgfTtcbiAgICBib2R5LmhtYWMgPSBhd2FpdCBjb21wdXRlSG1hYyh0aGlzLmhtYWNUb2tlbiwgdGhpcy5jYW5vbmljYWxpemUoYm9keSkpO1xuICAgIHRoaXMucG9ydC5wb3N0TWVzc2FnZShib2R5KTtcbiAgfVxuXG4gIHByaXZhdGUgY2Fub25pY2FsaXplKG1zZzogTmF0aXZlTWVzc2FnZSk6IHN0cmluZyB7XG4gICAgLy8gRXhjbHVkZSB0aGUgaG1hYyBmaWVsZCBpdHNlbGYg4oCUIHZlcmlmaWNhdGlvbiBzaWRlIHJlY29tcHV0ZXMgb3ZlciB0aGVcbiAgICAvLyBzYW1lIGV4Y2x1ZGVkLWhtYWMgc2hhcGUuXG4gICAgY29uc3QgeyBobWFjOiBfaCwgLi4ucmVzdCB9ID0gbXNnO1xuICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShyZXN0KTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgaGFuZGxlSW5jb21pbmcobXNnOiBOYXRpdmVNZXNzYWdlKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKCEoYXdhaXQgdmVyaWZ5SG1hYyhtc2csIHRoaXMuaG1hY1Rva2VuKSkpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tvd2VpYm8tYnJpZGdlXSBITUFDIG1pc21hdGNoOyBkcm9wcGluZyBtZXNzYWdlJywgbXNnLmNhbGxJZCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gUmVzcG9uc2UgdG8gb25lIG9mIG91ciBvdXRib3VuZCBjYWxscy5cbiAgICBpZiAobXNnLmRpcmVjdGlvbiA9PT0gJ3Jlc3BvbnNlJyB8fCB0aGlzLnBlbmRpbmcuaGFzKG1zZy5jYWxsSWQpKSB7XG4gICAgICBjb25zdCBlbnRyeSA9IHRoaXMucGVuZGluZy5nZXQobXNnLmNhbGxJZCk7XG4gICAgICBpZiAoIWVudHJ5KSByZXR1cm47XG4gICAgICB0aGlzLnBlbmRpbmcuZGVsZXRlKG1zZy5jYWxsSWQpO1xuICAgICAgaWYgKG1zZy5lcnJvcikgZW50cnkucmVqZWN0KG5ldyBFcnJvcihtc2cuZXJyb3IpKTtcbiAgICAgIGVsc2UgICAgICAgICAgIGVudHJ5LnJlc29sdmUobXNnLnJlc3VsdCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gSW5ib3VuZCBnYXRlIG9wZW4gcmVxdWVzdCBmcm9tIGhvc3QuXG4gICAgaWYgKG1zZy5nYXRlICYmIHR5cGVvZiBtc2cudGFiSWQgPT09ICdudW1iZXInICYmIHRoaXMuaW5ib3VuZEdhdGUpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHRoaXMuaW5ib3VuZEdhdGUobXNnLmdhdGUsIG1zZy50YWJJZCk7XG4gICAgICAgIGF3YWl0IHRoaXMuc2VuZFJlc3BvbnNlKG1zZy5jYWxsSWQsIHsgb2s6IHRydWUgfSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGF3YWl0IHRoaXMuc2VuZFJlc3BvbnNlKG1zZy5jYWxsSWQsIG51bGwsIChlIGFzIEVycm9yKS5tZXNzYWdlKTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBJbmJvdW5kIGFjdGlvbiByZXF1ZXN0IGZyb20gaG9zdC5cbiAgICBpZiAobXNnLmFjdGlvbiAmJiB0eXBlb2YgbXNnLnRhYklkID09PSAnbnVtYmVyJykge1xuICAgICAgaWYgKCF0aGlzLmluYm91bmRBY3Rpb24pIHtcbiAgICAgICAgYXdhaXQgdGhpcy5zZW5kUmVzcG9uc2UobXNnLmNhbGxJZCwgbnVsbCwgJ25vIGluYm91bmQgYWN0aW9uIGhhbmRsZXIgcmVnaXN0ZXJlZCcpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLmluYm91bmRBY3Rpb24obXNnLmFjdGlvbiwgbXNnLnRhYklkKTtcbiAgICAgICAgYXdhaXQgdGhpcy5zZW5kUmVzcG9uc2UobXNnLmNhbGxJZCwgcmVzdWx0KTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5zZW5kUmVzcG9uc2UobXNnLmNhbGxJZCwgbnVsbCwgKGUgYXMgRXJyb3IpLm1lc3NhZ2UpO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnNvbGUud2FybignW293ZWliby1icmlkZ2VdIGRyb3BwaW5nIHVucm91dGFibGUgbWVzc2FnZScsIG1zZy5jYWxsSWQpO1xuICB9XG5cbiAgcHJpdmF0ZSBmYWlsQWxsKGVycjogRXJyb3IpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IHsgcmVqZWN0IH0gb2YgdGhpcy5wZW5kaW5nLnZhbHVlcygpKSByZWplY3QoZXJyKTtcbiAgICB0aGlzLnBlbmRpbmcuY2xlYXIoKTtcbiAgfVxufVxuIiwiLy8gcGFja2FnZXMvYnJvd3Nlci1leHRlbnNpb24vc3JjL2NvbnRlbnQvQ29udGVudFNjcmlwdEFjdGlvbkVuZ2luZS50c1xuLy8gQmFja2dyb3VuZC1zaWRlIGRpc3BhdGNoZXIgZm9yIHRoZSAzOCBET00gYWN0aW9ucyB0aGF0IHJ1biBpbnNpZGUgdGhlIHBhZ2Vcbi8vIGRvY3VtZW50IHZpYSBhIGNvbnRlbnQgc2NyaXB0LiBQcm9kdWNlcyBpc1RydXN0ZWQ6IHRydWUgZXZlbnRzIOKAlFxuLy8gaW5kaXN0aW5ndWlzaGFibGUgZnJvbSByZWFsIHVzZXIgZ2VzdHVyZXMgdG8gUGVyaW1ldGVyWCwgRGF0YURvbWUsIEFrYW1haS5cbi8vXG4vLyBUaGUgMTMgcGFnZS1sZXZlbCBhY3Rpb25zIGxpc3RlZCBpbiBzaGFyZWQvYWN0aW9ucy50czpERUJVR0dFUl9BQ1RJT05TIGFyZVxuLy8gTk9UIGhhbmRsZWQgaGVyZSDigJQgY2FsbGVycyBkaXNwYXRjaCB0aG9zZSB0aHJvdWdoIERlYnVnZ2VyTGlmZWN5Y2xlTWFuYWdlci5cblxuaW1wb3J0IHR5cGUgeyBCcm93c2VyQWN0aW9uLCBDb250ZW50U2NyaXB0UmVzdWx0IH0gZnJvbSAnLi4vc2hhcmVkL2FjdGlvbnMuanMnO1xuXG5leHBvcnQgY2xhc3MgQ29udGVudFNjcmlwdEFjdGlvbkVuZ2luZSB7XG4gIHByaXZhdGUgcmVhZG9ubHkgaW5qZWN0ZWRUYWJzID0gbmV3IFNldDxudW1iZXI+KCk7XG5cbiAgLyoqIEluamVjdCBjb250ZW50LXNjcmlwdC5qcyAoaWRlbXBvdGVudCkgdGhlbiBwb3N0IHRoZSBhY3Rpb24gdmlhIHNlbmRNZXNzYWdlLiAqL1xuICBhc3luYyBkaXNwYXRjaCh0YWJJZDogbnVtYmVyLCBhY3Rpb246IEJyb3dzZXJBY3Rpb24pOiBQcm9taXNlPENvbnRlbnRTY3JpcHRSZXN1bHQ+IHtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgdGhpcy5lbnN1cmVJbmplY3RlZCh0YWJJZCk7XG4gICAgICBjb25zdCByZXN1bHQgPSAoYXdhaXQgY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UodGFiSWQsIHsgX19vd2VpYm86IHRydWUsIGFjdGlvbiB9KSkgYXNcbiAgICAgICAgQ29udGVudFNjcmlwdFJlc3VsdCB8IHVuZGVmaW5lZDtcbiAgICAgIHJldHVybiByZXN1bHQgPz8geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6ICdubyByZXNwb25zZSBmcm9tIGNvbnRlbnQgc2NyaXB0JyB9O1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogKGUgYXMgRXJyb3IpLm1lc3NhZ2UgfTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGVuc3VyZUluamVjdGVkKHRhYklkOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAodGhpcy5pbmplY3RlZFRhYnMuaGFzKHRhYklkKSkgcmV0dXJuO1xuICAgIGF3YWl0IGNocm9tZS5zY3JpcHRpbmcuZXhlY3V0ZVNjcmlwdCh7XG4gICAgICB0YXJnZXQ6IHsgdGFiSWQgfSxcbiAgICAgIGZpbGVzOiAgWydjb250ZW50LXNjcmlwdC5qcyddLFxuICAgIH0pO1xuICAgIHRoaXMuaW5qZWN0ZWRUYWJzLmFkZCh0YWJJZCk7XG4gIH1cblxuICAvKiogQ2FsbGVkIGJ5IHRhYnMub25SZW1vdmVkIC8gb25VcGRhdGVkIHRvIGRyb3Agc3RhbGUgY2FjaGUgZW50cmllcy4gKi9cbiAgZm9yZ2V0KHRhYklkOiBudW1iZXIpOiB2b2lkIHsgdGhpcy5pbmplY3RlZFRhYnMuZGVsZXRlKHRhYklkKTsgfVxufVxuIiwiLy8gcGFja2FnZXMvYnJvd3Nlci1leHRlbnNpb24vc3JjL2NvbnRlbnQvRGVidWdnZXJMaWZlY3ljbGVNYW5hZ2VyLnRzXG4vLyBMYXp5IGNocm9tZS5kZWJ1Z2dlciBhdHRhY2gvZGV0YWNoLiBEZWZhdWx0IHBvbGljeSBpcyAnbGF6eSc6IGF0dGFjaCBqdXN0XG4vLyBiZWZvcmUgZWFjaCBwYWdlLWxldmVsIGFjdGlvbiwgZGV0YWNoIGltbWVkaWF0ZWx5IGFmdGVyLiBGb3IgY29udGVudC1zY3JpcHQtXG4vLyBvbmx5IGZsb3dzIGNocm9tZS5kZWJ1Z2dlciBpcyBuZXZlciB0b3VjaGVkLCBzbyB0aGUgeWVsbG93IGJhbm5lciBpcyBhYnNlbnQuXG5cbmV4cG9ydCB0eXBlIERlYnVnZ2VyUG9saWN5ID0gJ3BlcnNpc3RlbnQnIHwgJ2xhenknO1xuXG5jb25zdCBERUJVR0dFUl9WRVJTSU9OID0gJzEuMyc7XG5cbmV4cG9ydCBjbGFzcyBEZWJ1Z2dlckxpZmVjeWNsZU1hbmFnZXIge1xuICBwcml2YXRlIGF0dGFjaGVkVGFicyA9IG5ldyBTZXQ8bnVtYmVyPigpO1xuXG4gIGNvbnN0cnVjdG9yKHB1YmxpYyBwb2xpY3k6IERlYnVnZ2VyUG9saWN5ID0gJ2xhenknKSB7fVxuXG4gIC8qKiBSdW4gYGZuYCB3aXRoIGNocm9tZS5kZWJ1Z2dlciBhdHRhY2hlZCB0byBgdGFiSWRgIHBlciB0aGUgYWN0aXZlIHBvbGljeS4gKi9cbiAgYXN5bmMgd2l0aERlYnVnZ2VyPFQ+KHRhYklkOiBudW1iZXIsIGZuOiAoKSA9PiBQcm9taXNlPFQ+KTogUHJvbWlzZTxUPiB7XG4gICAgaWYgKHRoaXMucG9saWN5ID09PSAncGVyc2lzdGVudCcpIHtcbiAgICAgIGF3YWl0IHRoaXMuZW5zdXJlQXR0YWNoZWQodGFiSWQpO1xuICAgICAgcmV0dXJuIGZuKCk7XG4gICAgfVxuICAgIGF3YWl0IHRoaXMuZW5zdXJlQXR0YWNoZWQodGFiSWQpO1xuICAgIHRyeSB7IHJldHVybiBhd2FpdCBmbigpOyB9XG4gICAgZmluYWxseSB7IGF3YWl0IHRoaXMuZGV0YWNoKHRhYklkKTsgfVxuICB9XG5cbiAgYXN5bmMgZW5zdXJlQXR0YWNoZWQodGFiSWQ6IG51bWJlcik6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLmF0dGFjaGVkVGFicy5oYXModGFiSWQpKSByZXR1cm47XG4gICAgYXdhaXQgY2hyb21lLmRlYnVnZ2VyLmF0dGFjaCh7IHRhYklkIH0sIERFQlVHR0VSX1ZFUlNJT04pO1xuICAgIHRoaXMuYXR0YWNoZWRUYWJzLmFkZCh0YWJJZCk7XG4gIH1cblxuICBhc3luYyBkZXRhY2godGFiSWQ6IG51bWJlcik6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICghdGhpcy5hdHRhY2hlZFRhYnMuaGFzKHRhYklkKSkgcmV0dXJuO1xuICAgIHRyeSB7IGF3YWl0IGNocm9tZS5kZWJ1Z2dlci5kZXRhY2goeyB0YWJJZCB9KTsgfVxuICAgIGNhdGNoIChlKSB7IGNvbnNvbGUud2FybignW293ZWliby1kZWJ1Z2dlcl0gZGV0YWNoIGZhaWxlZDonLCAoZSBhcyBFcnJvcikubWVzc2FnZSk7IH1cbiAgICB0aGlzLmF0dGFjaGVkVGFicy5kZWxldGUodGFiSWQpO1xuICB9XG5cbiAgYXN5bmMgZGV0YWNoQWxsKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IFByb21pc2UuYWxsU2V0dGxlZChbLi4udGhpcy5hdHRhY2hlZFRhYnNdLm1hcChpZCA9PiB0aGlzLmRldGFjaChpZCkpKTtcbiAgfVxufVxuIiwiLy8gcGFja2FnZXMvYnJvd3Nlci1leHRlbnNpb24vc3JjL2hpdGwvRGVza3RvcE5vdGlmaWNhdGlvbkZhbGxiYWNrLnRzXG4vLyBGaXJlcyBhbiBPUyBub3RpZmljYXRpb24gZm9yIGEgZ2F0ZSB3aGVuIGl0cyB0YWIgaXMgYmFja2dyb3VuZGVkLiBJZiB0aGVcbi8vIHVzZXIgaXMgbG9va2luZyBhdCB0aGUgdGFiLCB0aGUgaW4tdGFiIG92ZXJsYXkgaXMgc3VmZmljaWVudCBhbmQgd2Ugc2tpcC5cbi8vIEJ1dHRvbnMgb24gdGhlIG5vdGlmaWNhdGlvbiByZXNvbHZlIHRoZSBnYXRlIGRpcmVjdGx5IChhY2NlcHQgLyBkaXNtaXNzKTtcbi8vIGNsaWNraW5nIHRoZSBib2R5IGZvY3VzZXMgdGhlIHRhYiBzbyB0aGUgb3ZlcmxheSBiZWNvbWVzIHZpc2libGUuXG5cbmltcG9ydCB0eXBlIHsgR2F0ZVJlc29sdXRpb24sIEhJVExHYXRlIH0gZnJvbSAnLi4vc2hhcmVkL2FjdGlvbnMuanMnO1xuXG50eXBlIFJlc29sdmVIYW5kbGVyID0gKHI6IEdhdGVSZXNvbHV0aW9uKSA9PiB2b2lkO1xuXG5leHBvcnQgY2xhc3MgRGVza3RvcE5vdGlmaWNhdGlvbkZhbGxiYWNrIHtcbiAgcHJpdmF0ZSByZWFkb25seSBzaG93biA9IG5ldyBNYXA8c3RyaW5nLCB7IGdhdGVJZDogc3RyaW5nOyB0YWJJZDogbnVtYmVyIH0+KCk7XG4gIHByaXZhdGUgcmVzb2x2ZXI6IFJlc29sdmVIYW5kbGVyIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgd2lyZWQgPSBmYWxzZTtcblxuICBvblJlc29sdmUoaGFuZGxlcjogUmVzb2x2ZUhhbmRsZXIpOiB2b2lkIHtcbiAgICB0aGlzLnJlc29sdmVyID0gaGFuZGxlcjtcbiAgICBpZiAodGhpcy53aXJlZCkgcmV0dXJuO1xuICAgIHRoaXMud2lyZWQgPSB0cnVlO1xuXG4gICAgY2hyb21lLm5vdGlmaWNhdGlvbnMub25CdXR0b25DbGlja2VkLmFkZExpc3RlbmVyKChub3RpZmljYXRpb25JZCwgYnV0dG9uSW5kZXgpID0+IHtcbiAgICAgIGNvbnN0IGVudHJ5ID0gdGhpcy5zaG93bi5nZXQobm90aWZpY2F0aW9uSWQpO1xuICAgICAgaWYgKCFlbnRyeSkgcmV0dXJuO1xuICAgICAgdGhpcy5yZXNvbHZlcj8uKHtcbiAgICAgICAgZ2F0ZUlkOiBlbnRyeS5nYXRlSWQsXG4gICAgICAgIGFjY2VwdDogYnV0dG9uSW5kZXggPT09IDAsXG4gICAgICAgIHJlc29sdmVkQnk6ICdub3RpZmljYXRpb24nLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICBjaHJvbWUubm90aWZpY2F0aW9ucy5vbkNsaWNrZWQuYWRkTGlzdGVuZXIoKG5vdGlmaWNhdGlvbklkKSA9PiB7XG4gICAgICBjb25zdCBlbnRyeSA9IHRoaXMuc2hvd24uZ2V0KG5vdGlmaWNhdGlvbklkKTtcbiAgICAgIGlmICghZW50cnkpIHJldHVybjtcbiAgICAgIHZvaWQgY2hyb21lLnRhYnMudXBkYXRlKGVudHJ5LnRhYklkLCB7IGFjdGl2ZTogdHJ1ZSB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIHNob3coZ2F0ZTogSElUTEdhdGUsIHRhYklkOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgdGFiID0gYXdhaXQgY2hyb21lLnRhYnMuZ2V0KHRhYklkKTtcbiAgICAgIGNvbnN0IHdpbiA9IHRhYi53aW5kb3dJZCAhPSBudWxsID8gYXdhaXQgY2hyb21lLndpbmRvd3MuZ2V0KHRhYi53aW5kb3dJZCkgOiB1bmRlZmluZWQ7XG4gICAgICBpZiAodGFiLmFjdGl2ZSAmJiB3aW4/LmZvY3VzZWQpIHJldHVybjsgIC8vIGZvcmVncm91bmRlZCDigJQgb3ZlcmxheSBpcyBlbm91Z2hcblxuICAgICAgY29uc3Qgbm90aWZpY2F0aW9uSWQgPSBgb3dlaWJvLWhpdGwtJHtnYXRlLmdhdGVJZH1gO1xuICAgICAgYXdhaXQgY2hyb21lLm5vdGlmaWNhdGlvbnMuY3JlYXRlKG5vdGlmaWNhdGlvbklkLCB7XG4gICAgICAgIHR5cGU6ICdiYXNpYycsXG4gICAgICAgIGljb25Vcmw6ICdpY29ucy9pY29uMTI4LnBuZycsXG4gICAgICAgIHRpdGxlOiAnT3dlaWJvIG5lZWRzIHlvdXIgYXBwcm92YWwnLFxuICAgICAgICBtZXNzYWdlOiBnYXRlLm1lc3NhZ2UsXG4gICAgICAgIGJ1dHRvbnM6IFt7IHRpdGxlOiAnQWNjZXB0JyB9LCB7IHRpdGxlOiAnRGlzbWlzcycgfV0sXG4gICAgICAgIHJlcXVpcmVJbnRlcmFjdGlvbjogdHJ1ZSxcbiAgICAgICAgcHJpb3JpdHk6IDIsXG4gICAgICB9KTtcbiAgICAgIHRoaXMuc2hvd24uc2V0KG5vdGlmaWNhdGlvbklkLCB7IGdhdGVJZDogZ2F0ZS5nYXRlSWQsIHRhYklkIH0pO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUud2FybignW293ZWliby1oaXRsXSBub3RpZmljYXRpb24gc2hvdyBmYWlsZWQ6JywgKGUgYXMgRXJyb3IpLm1lc3NhZ2UpO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIGRpc21pc3MoZ2F0ZUlkOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBpZCA9IGBvd2VpYm8taGl0bC0ke2dhdGVJZH1gO1xuICAgIHRyeSB7IGF3YWl0IGNocm9tZS5ub3RpZmljYXRpb25zLmNsZWFyKGlkKTsgfSBjYXRjaCB7IC8qIG5vLW9wICovIH1cbiAgICB0aGlzLnNob3duLmRlbGV0ZShpZCk7XG4gIH1cbn1cbiIsIi8vIHBhY2thZ2VzL2Jyb3dzZXItZXh0ZW5zaW9uL3NyYy9oaXRsL0hJVExTdXJmYWNlQ29vcmRpbmF0b3IudHNcbi8vIFNpbmdsZSBnYXRlIGxpZmVjeWNsZSBhdXRob3JpdHkgZm9yIHRoZSB1bmlmaWVkIHRocmVlLXN1cmZhY2UgSElUTCBzeXN0ZW0uXG4vLyBBbGwgc3VyZmFjZXMgKGluLXRhYiBvdmVybGF5LCBPUyBub3RpZmljYXRpb24sIHBvcHVwKSByZWdpc3RlciB0aHJvdWdoIGl0LlxuLy8gRmlyc3QgcmVzcG9uc2Ugd2luczsgYWxsIG90aGVycyBkaXNtaXNzIGluc3RhbnRseS4gSWRlbXBvdGVudCBieSBnYXRlSWQuXG5cbmltcG9ydCB0eXBlIHsgR2F0ZVJlc29sdXRpb24sIEhJVExHYXRlIH0gZnJvbSAnLi4vc2hhcmVkL2FjdGlvbnMuanMnO1xuXG5pbXBvcnQgdHlwZSB7IERlc2t0b3BOb3RpZmljYXRpb25GYWxsYmFjayB9IGZyb20gJy4vRGVza3RvcE5vdGlmaWNhdGlvbkZhbGxiYWNrLmpzJztcbmltcG9ydCB0eXBlIHsgSW5UYWJISVRMT3ZlcmxheSB9IGZyb20gJy4vSW5UYWJISVRMT3ZlcmxheS5qcyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVzb2x2ZWRHYXRlU2luayB7XG4gIC8qKiBGb3J3YXJkcyBhIHJlc29sdmVkIGdhdGUgYmFjayB0byB0aGUgcGlwZWxpbmUgKHR5cGljYWxseSB2aWEgdGhlIGJyaWRnZSkuICovXG4gIG9uUmVzb2x2ZWQocmVzb2x1dGlvbjogR2F0ZVJlc29sdXRpb24pOiBQcm9taXNlPHZvaWQ+O1xufVxuXG5leHBvcnQgY2xhc3MgSElUTFN1cmZhY2VDb29yZGluYXRvciB7XG4gIHByaXZhdGUgcmVhZG9ubHkgZ2F0ZXMgPSBuZXcgTWFwPHN0cmluZywgeyBnYXRlOiBISVRMR2F0ZTsgdGFiSWQ6IG51bWJlcjsgcmVzb2x2ZWQ6IGJvb2xlYW4gfT4oKTtcblxuICBjb25zdHJ1Y3RvcihcbiAgICBwcml2YXRlIHJlYWRvbmx5IG92ZXJsYXk6ICAgICAgSW5UYWJISVRMT3ZlcmxheSxcbiAgICBwcml2YXRlIHJlYWRvbmx5IG5vdGlmaWNhdGlvbjogRGVza3RvcE5vdGlmaWNhdGlvbkZhbGxiYWNrLFxuICAgIHByaXZhdGUgcmVhZG9ubHkgc2luazogICAgICAgICBSZXNvbHZlZEdhdGVTaW5rLFxuICApIHtcbiAgICB0aGlzLm5vdGlmaWNhdGlvbi5vblJlc29sdmUoKHIpID0+IHZvaWQgdGhpcy5yZXNvbHZlKHIpKTtcbiAgfVxuXG4gIHBlbmRpbmdDb3VudCgpOiBudW1iZXIge1xuICAgIGxldCBuID0gMDtcbiAgICBmb3IgKGNvbnN0IGcgb2YgdGhpcy5nYXRlcy52YWx1ZXMoKSkgaWYgKCFnLnJlc29sdmVkKSBuKys7XG4gICAgcmV0dXJuIG47XG4gIH1cblxuICBsaXN0UGVuZGluZygpOiBISVRMR2F0ZVtdIHtcbiAgICByZXR1cm4gWy4uLnRoaXMuZ2F0ZXMudmFsdWVzKCldLmZpbHRlcihnID0+ICFnLnJlc29sdmVkKS5tYXAoZyA9PiBnLmdhdGUpO1xuICB9XG5cbiAgYXN5bmMgb3BlbihnYXRlOiBISVRMR2F0ZSwgdGFiSWQ6IG51bWJlcik6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLmdhdGVzLmhhcyhnYXRlLmdhdGVJZCkpIHJldHVybjtcbiAgICB0aGlzLmdhdGVzLnNldChnYXRlLmdhdGVJZCwgeyBnYXRlLCB0YWJJZCwgcmVzb2x2ZWQ6IGZhbHNlIH0pO1xuICAgIGF3YWl0IFByb21pc2UuYWxsU2V0dGxlZChbXG4gICAgICB0aGlzLm92ZXJsYXkuc2hvdyhnYXRlLCB0YWJJZCksXG4gICAgICB0aGlzLm5vdGlmaWNhdGlvbi5zaG93KGdhdGUsIHRhYklkKSxcbiAgICBdKTtcbiAgICB0aGlzLnVwZGF0ZUJhZGdlKCk7XG4gIH1cblxuICBhc3luYyByZXNvbHZlKHJlc29sdXRpb246IEdhdGVSZXNvbHV0aW9uKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgZW50cnkgPSB0aGlzLmdhdGVzLmdldChyZXNvbHV0aW9uLmdhdGVJZCk7XG4gICAgaWYgKCFlbnRyeSB8fCBlbnRyeS5yZXNvbHZlZCkgcmV0dXJuOyAgICAgICAgICAgLy8gaWRlbXBvdGVudFxuICAgIGVudHJ5LnJlc29sdmVkID0gdHJ1ZTtcbiAgICB0aGlzLmdhdGVzLmRlbGV0ZShyZXNvbHV0aW9uLmdhdGVJZCk7XG5cbiAgICBhd2FpdCBQcm9taXNlLmFsbFNldHRsZWQoW1xuICAgICAgdGhpcy5vdmVybGF5LmRpc21pc3MocmVzb2x1dGlvbi5nYXRlSWQsIGVudHJ5LnRhYklkKSxcbiAgICAgIHRoaXMubm90aWZpY2F0aW9uLmRpc21pc3MocmVzb2x1dGlvbi5nYXRlSWQpLFxuICAgICAgdGhpcy5zaW5rLm9uUmVzb2x2ZWQocmVzb2x1dGlvbiksXG4gICAgXSk7XG4gICAgdGhpcy51cGRhdGVCYWRnZSgpO1xuICB9XG5cbiAgcHJpdmF0ZSB1cGRhdGVCYWRnZSgpOiB2b2lkIHtcbiAgICBjb25zdCBuID0gdGhpcy5wZW5kaW5nQ291bnQoKTtcbiAgICB0cnkge1xuICAgICAgdm9pZCBjaHJvbWUuYWN0aW9uLnNldEJhZGdlVGV4dCh7IHRleHQ6IG4gPiAwID8gU3RyaW5nKG4pIDogJycgfSk7XG4gICAgICB2b2lkIGNocm9tZS5hY3Rpb24uc2V0QmFkZ2VCYWNrZ3JvdW5kQ29sb3IoeyBjb2xvcjogJyNkMDRhNGEnIH0pO1xuICAgIH0gY2F0Y2ggeyAvKiBNVjMgd29ya2VyIG1heSBiZSBzdGFydGluZzsgaWdub3JlICovIH1cbiAgfVxufVxuIiwiLy8gcGFja2FnZXMvYnJvd3Nlci1leHRlbnNpb24vc3JjL2hpdGwvSW5UYWJISVRMT3ZlcmxheS50c1xuLy8gQmFja2dyb3VuZC1zaWRlIGNvbnRyb2xsZXIgdGhhdCBpbmplY3RzIGhpdGwtb3ZlcmxheS5qcyBpbnRvIGEgdGFyZ2V0IHRhYlxuLy8gb24gZGVtYW5kIGFuZCBwb3N0cyBzaG93L2Rpc21pc3MgbWVzc2FnZXMgdG8gdGhlIG92ZXJsYXkgcnVubmluZyBpbnNpZGUgaXQuXG4vL1xuLy8gVGhlIGluLXRhYiBvdmVybGF5IGlzIGEgZmxvYXRpbmcgcGFuZWwgdG9wLXJpZ2h0IG9mIHRoZSBwYWdlIHdpdGhcbi8vIEFjY2VwdC9EaXNtaXNzIGJ1dHRvbnMuIE11bHRpcGxlIGNvbmN1cnJlbnQgZ2F0ZXMgc3RhY2sgdmVydGljYWxseS5cbi8vIEluamVjdGlvbiBzaWxlbnRseSBza2lwcyByZXN0cmljdGVkIHRhYnMgKGNocm9tZTovLywgZmlsZTovLywgd2Vic3RvcmUpLlxuXG5pbXBvcnQgdHlwZSB7IEhJVExHYXRlIH0gZnJvbSAnLi4vc2hhcmVkL2FjdGlvbnMuanMnO1xuXG5jb25zdCBSRVNUUklDVEVEX1BSRUZJWEVTID0gWydjaHJvbWU6Ly8nLCAnY2hyb21lLWV4dGVuc2lvbjovLycsICdlZGdlOi8vJywgJ2Fib3V0OicsICdmaWxlOi8vJywgJ2h0dHBzOi8vY2hyb21ld2Vic3RvcmUuZ29vZ2xlLmNvbSddO1xuXG5leHBvcnQgY2xhc3MgSW5UYWJISVRMT3ZlcmxheSB7XG4gIHByaXZhdGUgcmVhZG9ubHkgaW5qZWN0ZWQgPSBuZXcgU2V0PG51bWJlcj4oKTtcblxuICBhc3luYyBzaG93KGdhdGU6IEhJVExHYXRlLCB0YWJJZDogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKCEoYXdhaXQgdGhpcy50cnlJbmplY3QodGFiSWQpKSkgcmV0dXJuO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBjaHJvbWUudGFicy5zZW5kTWVzc2FnZSh0YWJJZCwgeyBfX293ZWlib0hpdGw6ICdzaG93JywgZ2F0ZSB9KTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLndhcm4oJ1tvd2VpYm8taGl0bF0gb3ZlcmxheSBzaG93IGZhaWxlZDonLCAoZSBhcyBFcnJvcikubWVzc2FnZSk7XG4gICAgfVxuICB9XG5cbiAgYXN5bmMgZGlzbWlzcyhnYXRlSWQ6IHN0cmluZywgdGFiSWQ6IG51bWJlcik6IFByb21pc2U8dm9pZD4ge1xuICAgIHRyeSB7IGF3YWl0IGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKHRhYklkLCB7IF9fb3dlaWJvSGl0bDogJ2Rpc21pc3MnLCBnYXRlSWQgfSk7IH1cbiAgICBjYXRjaCB7IC8qIHRhYiBtYXkgaGF2ZSBjbG9zZWQ7IGNvb3JkaW5hdG9yIGFscmVhZHkgdHJlYXRzIHRoaXMgYXMgaWRlbXBvdGVudCAqLyB9XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHRyeUluamVjdCh0YWJJZDogbnVtYmVyKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgaWYgKHRoaXMuaW5qZWN0ZWQuaGFzKHRhYklkKSkgcmV0dXJuIHRydWU7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHRhYiA9IGF3YWl0IGNocm9tZS50YWJzLmdldCh0YWJJZCk7XG4gICAgICBpZiAoIXRhYi51cmwgfHwgUkVTVFJJQ1RFRF9QUkVGSVhFUy5zb21lKHAgPT4gdGFiLnVybCEuc3RhcnRzV2l0aChwKSkpIHJldHVybiBmYWxzZTtcbiAgICAgIGF3YWl0IGNocm9tZS5zY3JpcHRpbmcuZXhlY3V0ZVNjcmlwdCh7IHRhcmdldDogeyB0YWJJZCB9LCBmaWxlczogWydoaXRsLW92ZXJsYXkuanMnXSB9KTtcbiAgICAgIHRoaXMuaW5qZWN0ZWQuYWRkKHRhYklkKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUud2FybignW293ZWliby1oaXRsXSBvdmVybGF5IGluamVjdCBmYWlsZWQ6JywgKGUgYXMgRXJyb3IpLm1lc3NhZ2UpO1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfVxuXG4gIGZvcmdldCh0YWJJZDogbnVtYmVyKTogdm9pZCB7IHRoaXMuaW5qZWN0ZWQuZGVsZXRlKHRhYklkKTsgfVxufVxuIiwiLy8gcGFja2FnZXMvYnJvd3Nlci1leHRlbnNpb24vc3JjL3NoYXJlZC9hY3Rpb25zLnRzXG4vLyBMb2NhbCBtaXJyb3Igb2YgdGhlIEJyb3dzZXJBY3Rpb24gZGlzY3JpbWluYXRlZCB1bmlvbiBhbmQgSElUTEdhdGUgdXNlZFxuLy8gaW5zaWRlIHRoZSBleHRlbnNpb24uIEludGVudGlvbmFsbHkgZHVwbGljYXRlZCAocmF0aGVyIHRoYW4gaW1wb3J0ZWQgZnJvbVxuLy8gQG93ZWliby9jb3JlLWNvbnRyYWN0cykgc28gdGhlIGV4dGVuc2lvbiBidWlsZCBoYXMgbm8gY3Jvc3MtcGFja2FnZSBkZXBzXG4vLyBhbmQgY2FuIGJlIGJ1bmRsZWQgaW50byBhIHNpbmdsZSBzZXJ2aWNlLXdvcmtlciBmaWxlLlxuLy9cbi8vIENhbm9uaWNhbCBzb3VyY2VzIGluIGNvcmUtY29udHJhY3RzL3NyYy9icm93c2VyLnRzIOKAlCBrZWVwIGluIHN5bmMuXG5cbmV4cG9ydCB0eXBlIEJyb3dzZXJBY3Rpb25UeXBlID1cbiAgfCAnbmF2aWdhdGUnIHwgJ2dvLWJhY2snIHwgJ2dvLWZvcndhcmQnIHwgJ3JlbG9hZCcgfCAnZ2V0LXVybCcgfCAnZ2V0LXRpdGxlJyB8ICdlbXVsYXRlLWRldmljZSdcbiAgfCAnY2xpY2snIHwgJ3R5cGUnIHwgJ3Njcm9sbCcgfCAnaG92ZXInIHwgJ3NlbGVjdCcgfCAnY2hlY2snIHwgJ3dhaXQnXG4gIHwgJ3dhaXQtZm9yLXNlbGVjdG9yJyB8ICdzdWJtaXQnIHwgJ2RyYWctYW5kLWRyb3AnIHwgJ21vdXNlLW1vdmUnIHwgJ21vdXNlLWRvd24nIHwgJ21vdXNlLXVwJ1xuICB8ICdzY3JlZW5zaG90JyB8ICdzbmFwc2hvdCcgfCAnZXh0cmFjdCdcbiAgfCAndGFiLW9wZW4nIHwgJ3RhYi1zd2l0Y2gnIHwgJ3RhYi1jbG9zZScgfCAndGFicy1saXN0J1xuICB8ICdzd2l0Y2gtdG8tZnJhbWUnIHwgJ3N3aXRjaC10by1tYWluJ1xuICB8ICd1cGxvYWQnIHwgJ2Rvd25sb2FkJyB8ICdtb3ZlLXRvLXVwbG9hZCdcbiAgfCAnY2xlYXItY29va2llcycgfCAnZ2V0LWNvb2tpZXMnIHwgJ3NldC1jb29raWVzJ1xuICB8ICdpbmplY3QtY3JlZGVudGlhbHMnIHwgJ2ltcG9ydC1jb29raWVzJyB8ICdhdXRvZmlsbC1jcmVkZW50aWFscydcbiAgfCAnZXZhbCcgfCAna2V5LWNob3JkJyB8ICdoYW5kbGUtZGlhbG9nJ1xuICB8ICdpbnRlcmNlcHQtcmVxdWVzdCcgfCAnbW9jay1yZXNwb25zZScgfCAncmVtb3ZlLWludGVyY2VwdCdcbiAgfCAncmVjb3JkLXZpZGVvLXN0YXJ0JyB8ICdyZWNvcmQtdmlkZW8tc3RvcCcgfCAnaGFyLXN0YXJ0JyB8ICdoYXItc3RvcCdcbiAgfCAnbG9nLWNhcHR1cmUtc3RhcnQnIHwgJ2xvZy1jYXB0dXJlLXN0b3AnIHwgJ2FjY2Vzc2liaWxpdHktc25hcHNob3QnXG4gIHwgJ3ByaW50LXRvLXBkZicgfCAnbG9hZC1leHRlbnNpb24nIHwgJ3NoYXJlLXNlc3Npb24nXG4gIHwgJ3NldC1nZW9sb2NhdGlvbicgfCAnZ3JhbnQtcGVybWlzc2lvbnMnIHwgJ3Jldm9rZS1wZXJtaXNzaW9ucydcbiAgfCAnZXh0ZW5zaW9uLWhpdGwtcmVzcG9uZCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQmFzZUFjdGlvbiB7IHR5cGU6IEJyb3dzZXJBY3Rpb25UeXBlIH1cblxuLy8gVGhlIGVuZ2luZSBvbmx5IG5lZWRzIHRvIGRpc2NyaW1pbmF0ZSBvbiBgdHlwZWAgcGx1cyBmaWVsZHMgaXQgZm9yd2FyZHMgdG9cbi8vIHRoZSBwYWdlLiBBIGxvb3NlIHN0cnVjdHVyYWwgdHlwZSBrZWVwcyB0aGUgZmlsZSBjb21wYWN0IHdoaWxlIHJlbWFpbmluZ1xuLy8gdHlwZS1zYWZlIGF0IGNhbGwgc2l0ZXMgdGhhdCBuYXJyb3cgb24gYHR5cGVgLlxuZXhwb3J0IHR5cGUgQnJvd3NlckFjdGlvbiA9IEJhc2VBY3Rpb24gJiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcblxuLyoqIDEzIHBhZ2UtbGV2ZWwgYWN0aW9ucyB0aGF0IHN0aWxsIHJlcXVpcmUgY2hyb21lLmRlYnVnZ2VyIC8gQ0RQLiAqL1xuZXhwb3J0IGNvbnN0IERFQlVHR0VSX0FDVElPTlM6IFJlYWRvbmx5U2V0PEJyb3dzZXJBY3Rpb25UeXBlPiA9IG5ldyBTZXQ8QnJvd3NlckFjdGlvblR5cGU+KFtcbiAgJ25hdmlnYXRlJywgJ3NjcmVlbnNob3QnLCAnZXZhbCcsICdhY2Nlc3NpYmlsaXR5LXNuYXBzaG90JyxcbiAgJ3N3aXRjaC10by1mcmFtZScsICdoYW5kbGUtZGlhbG9nJywgJ2ludGVyY2VwdC1yZXF1ZXN0JywgJ21vY2stcmVzcG9uc2UnLCAncmVtb3ZlLWludGVyY2VwdCcsXG4gICdsb2ctY2FwdHVyZS1zdGFydCcsICdsb2ctY2FwdHVyZS1zdG9wJywgJ2tleS1jaG9yZCcsXG4gICdyZWNvcmQtdmlkZW8tc3RhcnQnLCAncmVjb3JkLXZpZGVvLXN0b3AnLCAnaGFyLXN0YXJ0JywgJ2hhci1zdG9wJyxcbl0pO1xuXG4vKiogQ29va2llIGFjdGlvbnMgcm91dGVkIHRocm91Z2ggdGhlIGNocm9tZS5jb29raWVzIEFQSSBkaXJlY3RseS4gKi9cbmV4cG9ydCBjb25zdCBDT09LSUVfQUNUSU9OUzogUmVhZG9ubHlTZXQ8QnJvd3NlckFjdGlvblR5cGU+ID0gbmV3IFNldDxCcm93c2VyQWN0aW9uVHlwZT4oW1xuICAnY2xlYXItY29va2llcycsICdnZXQtY29va2llcycsICdzZXQtY29va2llcycsICdpbXBvcnQtY29va2llcycsXG5dKTtcblxuZXhwb3J0IGZ1bmN0aW9uIHJvdXRlRm9yKHR5cGU6IEJyb3dzZXJBY3Rpb25UeXBlKTogJ2RlYnVnZ2VyJyB8ICdjb29raWVzJyB8ICdjb250ZW50JyB7XG4gIGlmIChERUJVR0dFUl9BQ1RJT05TLmhhcyh0eXBlKSkgcmV0dXJuICdkZWJ1Z2dlcic7XG4gIGlmIChDT09LSUVfQUNUSU9OUy5oYXModHlwZSkpICAgcmV0dXJuICdjb29raWVzJztcbiAgcmV0dXJuICdjb250ZW50Jztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDb250ZW50U2NyaXB0UmVzdWx0IHtcbiAgc3VjY2VzczogYm9vbGVhbjtcbiAgZGF0YT86ICAgdW5rbm93bjtcbiAgZXJyb3I/OiAgc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEhJVExHYXRlIHtcbiAgZ2F0ZUlkOiBzdHJpbmc7XG4gIHR5cGU6ICdkaWFsb2cnIHwgJ3Zpc2lvbi1sb29wJztcbiAgbWVzc2FnZTogc3RyaW5nO1xuICBkaWFsb2dUeXBlPzogJ2FsZXJ0JyB8ICdjb25maXJtJyB8ICdwcm9tcHQnIHwgJ2JlZm9yZXVubG9hZCc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgR2F0ZVJlc29sdXRpb24ge1xuICBnYXRlSWQ6IHN0cmluZztcbiAgYWNjZXB0OiBib29sZWFuO1xuICBwcm9tcHRUZXh0Pzogc3RyaW5nO1xuICByZXNvbHZlZEJ5OiAnb3ZlcmxheScgfCAnbm90aWZpY2F0aW9uJyB8ICdwb3B1cCcgfCAndGVybWluYWwnO1xufVxuIiwiLy8gVGhlIG1vZHVsZSBjYWNoZVxudmFyIF9fd2VicGFja19tb2R1bGVfY2FjaGVfXyA9IHt9O1xuXG4vLyBUaGUgcmVxdWlyZSBmdW5jdGlvblxuZnVuY3Rpb24gX193ZWJwYWNrX3JlcXVpcmVfXyhtb2R1bGVJZCkge1xuXHQvLyBDaGVjayBpZiBtb2R1bGUgaXMgaW4gY2FjaGVcblx0dmFyIGNhY2hlZE1vZHVsZSA9IF9fd2VicGFja19tb2R1bGVfY2FjaGVfX1ttb2R1bGVJZF07XG5cdGlmIChjYWNoZWRNb2R1bGUgIT09IHVuZGVmaW5lZCkge1xuXHRcdHJldHVybiBjYWNoZWRNb2R1bGUuZXhwb3J0cztcblx0fVxuXHQvLyBDcmVhdGUgYSBuZXcgbW9kdWxlIChhbmQgcHV0IGl0IGludG8gdGhlIGNhY2hlKVxuXHR2YXIgbW9kdWxlID0gX193ZWJwYWNrX21vZHVsZV9jYWNoZV9fW21vZHVsZUlkXSA9IHtcblx0XHQvLyBubyBtb2R1bGUuaWQgbmVlZGVkXG5cdFx0Ly8gbm8gbW9kdWxlLmxvYWRlZCBuZWVkZWRcblx0XHRleHBvcnRzOiB7fVxuXHR9O1xuXG5cdC8vIEV4ZWN1dGUgdGhlIG1vZHVsZSBmdW5jdGlvblxuXHRpZiAoIShtb2R1bGVJZCBpbiBfX3dlYnBhY2tfbW9kdWxlc19fKSkge1xuXHRcdGRlbGV0ZSBfX3dlYnBhY2tfbW9kdWxlX2NhY2hlX19bbW9kdWxlSWRdO1xuXHRcdHZhciBlID0gbmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIiArIG1vZHVsZUlkICsgXCInXCIpO1xuXHRcdGUuY29kZSA9ICdNT0RVTEVfTk9UX0ZPVU5EJztcblx0XHR0aHJvdyBlO1xuXHR9XG5cdF9fd2VicGFja19tb2R1bGVzX19bbW9kdWxlSWRdKG1vZHVsZSwgbW9kdWxlLmV4cG9ydHMsIF9fd2VicGFja19yZXF1aXJlX18pO1xuXG5cdC8vIFJldHVybiB0aGUgZXhwb3J0cyBvZiB0aGUgbW9kdWxlXG5cdHJldHVybiBtb2R1bGUuZXhwb3J0cztcbn1cblxuIiwiLy8gZGVmaW5lIGdldHRlciBmdW5jdGlvbnMgZm9yIGhhcm1vbnkgZXhwb3J0c1xuX193ZWJwYWNrX3JlcXVpcmVfXy5kID0gKGV4cG9ydHMsIGRlZmluaXRpb24pID0+IHtcblx0Zm9yKHZhciBrZXkgaW4gZGVmaW5pdGlvbikge1xuXHRcdGlmKF9fd2VicGFja19yZXF1aXJlX18ubyhkZWZpbml0aW9uLCBrZXkpICYmICFfX3dlYnBhY2tfcmVxdWlyZV9fLm8oZXhwb3J0cywga2V5KSkge1xuXHRcdFx0T2JqZWN0LmRlZmluZVByb3BlcnR5KGV4cG9ydHMsIGtleSwgeyBlbnVtZXJhYmxlOiB0cnVlLCBnZXQ6IGRlZmluaXRpb25ba2V5XSB9KTtcblx0XHR9XG5cdH1cbn07IiwiX193ZWJwYWNrX3JlcXVpcmVfXy5vID0gKG9iaiwgcHJvcCkgPT4gKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChvYmosIHByb3ApKSIsIi8vIGRlZmluZSBfX2VzTW9kdWxlIG9uIGV4cG9ydHNcbl9fd2VicGFja19yZXF1aXJlX18uciA9IChleHBvcnRzKSA9PiB7XG5cdGlmKHR5cGVvZiBTeW1ib2wgIT09ICd1bmRlZmluZWQnICYmIFN5bWJvbC50b1N0cmluZ1RhZykge1xuXHRcdE9iamVjdC5kZWZpbmVQcm9wZXJ0eShleHBvcnRzLCBTeW1ib2wudG9TdHJpbmdUYWcsIHsgdmFsdWU6ICdNb2R1bGUnIH0pO1xuXHR9XG5cdE9iamVjdC5kZWZpbmVQcm9wZXJ0eShleHBvcnRzLCAnX19lc01vZHVsZScsIHsgdmFsdWU6IHRydWUgfSk7XG59OyIsIi8vIHBhY2thZ2VzL2Jyb3dzZXItZXh0ZW5zaW9uL3NyYy9iYWNrZ3JvdW5kLnRzXG4vLyBNVjMgc2VydmljZSB3b3JrZXIg4oCUIHNpbmdsZSBlbnRyeSBwb2ludCBmb3IgYWxsIGJyaWRnZSwgYWN0aW9uLCBhbmQgSElUTFxuLy8gdHJhZmZpYy4gV2lyZXMgdG9nZXRoZXIgdGhlIHY5LjUuOSBjb21wb25lbnRzOlxuLy9cbi8vICAg4oCiIE5hdGl2ZU1lc3NhZ2luZ0JyaWRnZSAgICAgICDigJQgZGVmYXVsdCB0cmFuc3BvcnQgKGNocm9tZS5ydW50aW1lLmNvbm5lY3ROYXRpdmUpXG4vLyAgIOKAoiBFeHRlbnNpb25CcmlkZ2VTZXJ2ZXIgICAgICAg4oCUIGxlZ2FjeSBXZWJTb2NrZXQgY2xpZW50IChAZGVwcmVjYXRlZCwgd2Vic29ja2V0IG1vZGUpXG4vLyAgIOKAoiBFeHRlbnNpb25ISVRMQnJpZGdlICAgICAgICAg4oCUIHNpbmdsZSBISVRMIGdhdGUgYXV0aG9yaXR5OyBkZWxlZ2F0ZXMgdG8gY29vcmRpbmF0b3Jcbi8vICAg4oCiIENvbnRlbnRTY3JpcHRBY3Rpb25FbmdpbmUgICDigJQgMzggRE9NIGFjdGlvbnMgdmlhIGNvbnRlbnQtc2NyaXB0LmpzIChpc1RydXN0ZWQ6IHRydWUpXG4vLyAgIOKAoiBEZWJ1Z2dlckxpZmVjeWNsZU1hbmFnZXIgICAg4oCUIGxhenkgYXR0YWNoL2RldGFjaCBmb3IgMTMgcGFnZS1sZXZlbCBDRFAgb3BzXG4vLyAgIOKAoiBISVRMU3VyZmFjZUNvb3JkaW5hdG9yICAgICAg4oCUIGZhbnMgZ2F0ZXMgdG8gaW4tdGFiIG92ZXJsYXkgKyBPUyBub3RpZmljYXRpb24gKyBwb3B1cFxuLy9cbi8vIFRoZSBjb29raWUgYWN0aW9ucyAoY2xlYXIvZ2V0L3NldC9pbXBvcnQpIGhpdCBjaHJvbWUuY29va2llcyBkaXJlY3RseS5cblxuaW1wb3J0IHsgTmF0aXZlTWVzc2FnaW5nQnJpZGdlIH0gZnJvbSAnLi9icmlkZ2UvTmF0aXZlTWVzc2FnaW5nQnJpZGdlLmpzJztcbmltcG9ydCB7IEV4dGVuc2lvbkJyaWRnZVNlcnZlciB9IGZyb20gJy4vYnJpZGdlL0V4dGVuc2lvbkJyaWRnZVNlcnZlci5qcyc7XG5pbXBvcnQgeyBFeHRlbnNpb25ISVRMQnJpZGdlIH0gZnJvbSAnLi9icmlkZ2UvRXh0ZW5zaW9uSElUTEJyaWRnZS5qcyc7XG5pbXBvcnQgeyBDb250ZW50U2NyaXB0QWN0aW9uRW5naW5lIH0gZnJvbSAnLi9jb250ZW50L0NvbnRlbnRTY3JpcHRBY3Rpb25FbmdpbmUuanMnO1xuaW1wb3J0IHsgRGVidWdnZXJMaWZlY3ljbGVNYW5hZ2VyIH0gZnJvbSAnLi9jb250ZW50L0RlYnVnZ2VyTGlmZWN5Y2xlTWFuYWdlci5qcyc7XG5pbXBvcnQgeyBEZXNrdG9wTm90aWZpY2F0aW9uRmFsbGJhY2sgfSBmcm9tICcuL2hpdGwvRGVza3RvcE5vdGlmaWNhdGlvbkZhbGxiYWNrLmpzJztcbmltcG9ydCB7IEhJVExTdXJmYWNlQ29vcmRpbmF0b3IsIHR5cGUgUmVzb2x2ZWRHYXRlU2luayB9IGZyb20gJy4vaGl0bC9ISVRMU3VyZmFjZUNvb3JkaW5hdG9yLmpzJztcbmltcG9ydCB7IEluVGFiSElUTE92ZXJsYXkgfSBmcm9tICcuL2hpdGwvSW5UYWJISVRMT3ZlcmxheS5qcyc7XG5pbXBvcnQgeyByb3V0ZUZvciwgdHlwZSBCcm93c2VyQWN0aW9uLCB0eXBlIEdhdGVSZXNvbHV0aW9uLCB0eXBlIEhJVExHYXRlIH0gZnJvbSAnLi9zaGFyZWQvYWN0aW9ucy5qcyc7XG5pbXBvcnQgdHlwZSB7IEJyaWRnZU1lc3NhZ2UgfSBmcm9tICcuL3NoYXJlZC9wcm90b2NvbC5qcyc7XG5cbi8vIOKUgOKUgCBDb21wb25lbnQgZ3JhcGgg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5jb25zdCBuYXRpdmVCcmlkZ2UgID0gbmV3IE5hdGl2ZU1lc3NhZ2luZ0JyaWRnZSgpO1xuY29uc3QgbGVnYWN5QnJpZGdlICA9IG5ldyBFeHRlbnNpb25CcmlkZ2VTZXJ2ZXIoKTsgICAvLyBAZGVwcmVjYXRlZCDigJQgd2Vic29ja2V0IG1vZGUgb25seVxuY29uc3QgY29udGVudEVuZ2luZSA9IG5ldyBDb250ZW50U2NyaXB0QWN0aW9uRW5naW5lKCk7XG5jb25zdCBkZWJ1Z2dlck1nciAgID0gbmV3IERlYnVnZ2VyTGlmZWN5Y2xlTWFuYWdlcignbGF6eScpO1xuY29uc3Qgb3ZlcmxheSAgICAgICA9IG5ldyBJblRhYkhJVExPdmVybGF5KCk7XG5jb25zdCBub3RpZmljYXRpb24gID0gbmV3IERlc2t0b3BOb3RpZmljYXRpb25GYWxsYmFjaygpO1xuXG4vLyBTaW5rIGZvcndhcmRzIG92ZXJsYXkvcG9wdXAvbm90aWZpY2F0aW9uIHJlc29sdXRpb25zIGJhY2sgdGhyb3VnaCB3aGljaGV2ZXJcbi8vIHRyYW5zcG9ydCBpcyBhY3RpdmUgYXMgYW4gYGV4dGVuc2lvbi1oaXRsLXJlc3BvbmRgIGFjdGlvbi5cbmNvbnN0IGdhdGVTaW5rOiBSZXNvbHZlZEdhdGVTaW5rID0ge1xuICBhc3luYyBvblJlc29sdmVkKHI6IEdhdGVSZXNvbHV0aW9uKSB7XG4gICAgdHJ5IHtcbiAgICAgIGlmIChuYXRpdmVCcmlkZ2UuaXNDb25uZWN0ZWQoKSkge1xuICAgICAgICBhd2FpdCBuYXRpdmVCcmlkZ2Uuc2VuZEFjdGlvbihjcnlwdG8ucmFuZG9tVVVJRCgpLCB7XG4gICAgICAgICAgdHlwZTogJ2V4dGVuc2lvbi1oaXRsLXJlc3BvbmQnLFxuICAgICAgICAgIGdhdGVJZDogci5nYXRlSWQsXG4gICAgICAgICAgYWNjZXB0OiByLmFjY2VwdCxcbiAgICAgICAgICBwcm9tcHRUZXh0OiByLnByb21wdFRleHQsXG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIGlmIChsZWdhY3lCcmlkZ2UuaXNDb25uZWN0ZWQoKSkge1xuICAgICAgICBsZWdhY3lCcmlkZ2Uuc2VuZEdhdGVSZXNvbHZlZChyLmdhdGVJZCwgci5hY2NlcHQpO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUud2FybignW293ZWliby1oaXRsXSBzaW5rIHNlbmQgZmFpbGVkOicsIChlIGFzIEVycm9yKS5tZXNzYWdlKTtcbiAgICB9XG4gIH0sXG59O1xuXG5jb25zdCBjb29yZGluYXRvciA9IG5ldyBISVRMU3VyZmFjZUNvb3JkaW5hdG9yKG92ZXJsYXksIG5vdGlmaWNhdGlvbiwgZ2F0ZVNpbmspO1xuXG4vLyBISVRMQnJpZGdlIGVuY2Fwc3VsYXRlcyBhbGwgZ2F0ZSBvcGVuL3Jlc29sdmUvbGlzdCBsb2dpYyBhbmQgYmFkZ2UgbWFuYWdlbWVudC5cbmNvbnN0IGhpdGxCcmlkZ2UgPSBuZXcgRXh0ZW5zaW9uSElUTEJyaWRnZSh7XG4gIGNvb3JkaW5hdG9yLFxuICBuYXRpdmVCcmlkZ2UsXG4gIGxlZ2FjeUJyaWRnZSxcbn0pO1xuXG4vLyDilIDilIAgU3RhdGUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5sZXQgc2Vzc2lvblRva2VuOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbmNvbnN0IEJSSURHRV9NT0RFX0tFWSA9ICdleHRlbnNpb25CcmlkZ2VNb2RlJztcblxuYXN5bmMgZnVuY3Rpb24gbG9hZFBlcnNpc3RlZFN0YXRlKCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBzdG9yZWQgPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoWydzZXNzaW9uVG9rZW4nLCBCUklER0VfTU9ERV9LRVldKTtcbiAgc2Vzc2lvblRva2VuID0gKHN0b3JlZFsnc2Vzc2lvblRva2VuJ10gYXMgc3RyaW5nIHwgdW5kZWZpbmVkKSA/PyBudWxsO1xuICBjb25zdCBtb2RlID0gKHN0b3JlZFtCUklER0VfTU9ERV9LRVldIGFzICduYXRpdmUnIHwgJ3dlYnNvY2tldCcgfCB1bmRlZmluZWQpID8/ICduYXRpdmUnO1xuICBpZiAoc2Vzc2lvblRva2VuICYmIG1vZGUgPT09ICduYXRpdmUnKSB7XG4gICAgbmF0aXZlQnJpZGdlLmNvbm5lY3Qoc2Vzc2lvblRva2VuKTtcbiAgfVxufVxuXG4vLyDilIDilIAgQWN0aW9uIGRpc3BhdGNoIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZUFjdGlvbih0YWJJZDogbnVtYmVyLCBhY3Rpb246IEJyb3dzZXJBY3Rpb24pOiBQcm9taXNlPHVua25vd24+IHtcbiAgY29uc3Qgcm91dGUgPSByb3V0ZUZvcihhY3Rpb24udHlwZSk7XG5cbiAgaWYgKHJvdXRlID09PSAnY29va2llcycpIHtcbiAgICByZXR1cm4gZXhlY3V0ZUNvb2tpZUFjdGlvbihhY3Rpb24pO1xuICB9XG5cbiAgaWYgKHJvdXRlID09PSAnZGVidWdnZXInKSB7XG4gICAgcmV0dXJuIGRlYnVnZ2VyTWdyLndpdGhEZWJ1Z2dlcih0YWJJZCwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgY2RwID0gYWN0aW9uLmNkcCBhcyB7IG1ldGhvZDogc3RyaW5nOyBwYXJhbXM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB9IHwgdW5kZWZpbmVkO1xuICAgICAgaWYgKCFjZHApIHRocm93IG5ldyBFcnJvcihgZGVidWdnZXIgcm91dGUgbWlzc2luZyBjZHAgcGF5bG9hZCBmb3IgJHthY3Rpb24udHlwZX1gKTtcbiAgICAgIHJldHVybiBjaHJvbWUuZGVidWdnZXIuc2VuZENvbW1hbmQoeyB0YWJJZCB9LCBjZHAubWV0aG9kLCBjZHAucGFyYW1zKTtcbiAgICB9KTtcbiAgfVxuXG4gIC8vIDM4IGNvbnRlbnQtc2NyaXB0IGFjdGlvbnNcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY29udGVudEVuZ2luZS5kaXNwYXRjaCh0YWJJZCwgYWN0aW9uKTtcbiAgaWYgKCFyZXN1bHQuc3VjY2VzcykgdGhyb3cgbmV3IEVycm9yKHJlc3VsdC5lcnJvciA/PyAnY29udGVudCBzY3JpcHQgZmFpbGVkJyk7XG4gIHJldHVybiByZXN1bHQuZGF0YTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZUNvb2tpZUFjdGlvbihhY3Rpb246IEJyb3dzZXJBY3Rpb24pOiBQcm9taXNlPHVua25vd24+IHtcbiAgc3dpdGNoIChhY3Rpb24udHlwZSkge1xuICAgIGNhc2UgJ2dldC1jb29raWVzJzoge1xuICAgICAgY29uc3QgZG9tYWluID0gYWN0aW9uLmRvbWFpbiBhcyBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgICBjb25zdCBjb29raWVzID0gYXdhaXQgY2hyb21lLmNvb2tpZXMuZ2V0QWxsKGRvbWFpbiA/IHsgZG9tYWluIH0gOiB7fSk7XG4gICAgICByZXR1cm4gY29va2llcztcbiAgICB9XG4gICAgY2FzZSAnY2xlYXItY29va2llcyc6IHtcbiAgICAgIGNvbnN0IGRvbWFpbiA9IGFjdGlvbi5kb21haW4gYXMgc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgICAgY29uc3QgY29va2llcyA9IGF3YWl0IGNocm9tZS5jb29raWVzLmdldEFsbChkb21haW4gPyB7IGRvbWFpbiB9IDoge30pO1xuICAgICAgYXdhaXQgUHJvbWlzZS5hbGwoY29va2llcy5tYXAoYyA9PlxuICAgICAgICBjaHJvbWUuY29va2llcy5yZW1vdmUoe1xuICAgICAgICAgIHVybDogYCR7Yy5zZWN1cmUgPyAnaHR0cHMnIDogJ2h0dHAnfTovLyR7Yy5kb21haW4ucmVwbGFjZSgvXlxcLi8sICcnKX0ke2MucGF0aH1gLFxuICAgICAgICAgIG5hbWU6IGMubmFtZSxcbiAgICAgICAgfSksXG4gICAgICApKTtcbiAgICAgIHJldHVybiB7IGNsZWFyZWQ6IGNvb2tpZXMubGVuZ3RoIH07XG4gICAgfVxuICAgIGNhc2UgJ3NldC1jb29raWVzJzoge1xuICAgICAgY29uc3QgbGlzdCA9IChhY3Rpb24uY29va2llcyBhcyBjaHJvbWUuY29va2llcy5TZXREZXRhaWxzW10pID8/IFtdO1xuICAgICAgYXdhaXQgUHJvbWlzZS5hbGwobGlzdC5tYXAoYyA9PiBjaHJvbWUuY29va2llcy5zZXQoYykpKTtcbiAgICAgIHJldHVybiB7IHNldDogbGlzdC5sZW5ndGggfTtcbiAgICB9XG4gICAgY2FzZSAnaW1wb3J0LWNvb2tpZXMnOiB7XG4gICAgICBjb25zdCBkb21haW4gPSBhY3Rpb24uZG9tYWluIGFzIHN0cmluZztcbiAgICAgIHJldHVybiBjaHJvbWUuY29va2llcy5nZXRBbGwoeyBkb21haW4gfSk7XG4gICAgfVxuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYHVuc3VwcG9ydGVkIGNvb2tpZSBhY3Rpb246ICR7YWN0aW9uLnR5cGV9YCk7XG4gIH1cbn1cblxuLy8g4pSA4pSAIE5hdGl2ZSBob3N0IG1lc3NhZ2UgaW5ncmVzcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbm5hdGl2ZUJyaWRnZS5vbkluYm91bmRBY3Rpb24oYXN5bmMgKGFjdGlvbiwgdGFiSWQpID0+IHtcbiAgcmV0dXJuIGV4ZWN1dGVBY3Rpb24odGFiSWQsIGFjdGlvbik7XG59KTtcbm5hdGl2ZUJyaWRnZS5vbkluYm91bmRHYXRlKGFzeW5jIChnYXRlLCB0YWJJZCkgPT4ge1xuICBhd2FpdCBoaXRsQnJpZGdlLm9wZW5HYXRlKFxuICAgIHsgZ2F0ZUlkOiBnYXRlLmdhdGVJZCwgdHlwZTogZ2F0ZS50eXBlLCBtZXNzYWdlOiBnYXRlLm1lc3NhZ2UgfSxcbiAgICB0YWJJZCxcbiAgKTtcbn0pO1xuXG4vLyDilIDilIAgTGVnYWN5IFdTIGJyaWRnZTogYWN0aW9uIGFuZCBnYXRlIGhhbmRsZXJzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxubGVnYWN5QnJpZGdlLm9uQWN0aW9uKGFzeW5jIChhY3Rpb24sIGNhbGxJZCwgdGFiSWQpID0+IHtcbiAgcmV0dXJuIGV4ZWN1dGVBY3Rpb24odGFiSWQsIGFjdGlvbik7XG59KTtcbmxlZ2FjeUJyaWRnZS5vbkdhdGUoYXN5bmMgKGdhdGUsIHRhYklkKSA9PiB7XG4gIGF3YWl0IGhpdGxCcmlkZ2Uub3BlbkdhdGUoZ2F0ZSwgdGFiSWQpO1xufSk7XG5cbi8vIOKUgOKUgCBSdW50aW1lIG1lc3NhZ2VzIChvdmVybGF5IOKGkiBiYWNrZ3JvdW5kLCBwb3B1cCDihpIgYmFja2dyb3VuZCkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5jaHJvbWUucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoKG1zZzoge1xuICBfX293ZWlib0hpdGxSZXNvbHZlPzogYm9vbGVhbjtcbiAgZ2F0ZUlkPzogc3RyaW5nO1xuICBhY2NlcHQ/OiBib29sZWFuO1xuICBwcm9tcHRUZXh0Pzogc3RyaW5nO1xuICBjbWQ/OiBzdHJpbmc7XG4gIHBhaXJUb2tlbj86IHN0cmluZztcbiAgaG9zdD86IHN0cmluZztcbiAgZ2F0ZT86IEhJVExHYXRlO1xuICB0YWJJZD86IG51bWJlcjtcbn0sIF9zZW5kZXIsIHNlbmRSZXNwb25zZSkgPT4ge1xuICAvLyBPdmVybGF5IHJlc29sdXRpb24uXG4gIGlmIChtc2cuX19vd2VpYm9IaXRsUmVzb2x2ZSAmJiBtc2cuZ2F0ZUlkKSB7XG4gICAgdm9pZCBoaXRsQnJpZGdlLnJlc29sdmVHYXRlKHtcbiAgICAgIGdhdGVJZDogbXNnLmdhdGVJZCxcbiAgICAgIGFjY2VwdDogQm9vbGVhbihtc2cuYWNjZXB0KSxcbiAgICAgIHByb21wdFRleHQ6IG1zZy5wcm9tcHRUZXh0LFxuICAgICAgcmVzb2x2ZWRCeTogJ292ZXJsYXknLFxuICAgIH0pO1xuICAgIHNlbmRSZXNwb25zZSh7IG9rOiB0cnVlIH0pO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIC8vIERlZXAtbGluayBwYWlyaW5nIChmcm9tIHBhaXIuaHRtbCkuXG4gIGlmIChtc2cuY21kID09PSAncGFpci1kZWVwbGluaycgJiYgbXNnLnBhaXJUb2tlbikge1xuICAgIHNlc3Npb25Ub2tlbiA9IG1zZy5wYWlyVG9rZW47XG4gICAgdm9pZCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBzZXNzaW9uVG9rZW4sIFtCUklER0VfTU9ERV9LRVldOiAnbmF0aXZlJyB9KS50aGVuKCgpID0+IHtcbiAgICAgIG5hdGl2ZUJyaWRnZS5jb25uZWN0KG1zZy5wYWlyVG9rZW4hKTtcbiAgICAgIHNlbmRSZXNwb25zZSh7IG9rOiB0cnVlIH0pO1xuICAgIH0pO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgLy8gUG9wdXAgZ2F0ZSByZXNvbHV0aW9uLlxuICBpZiAobXNnLmNtZCA9PT0gJ2hpdGwtcmVzb2x2ZScgJiYgbXNnLmdhdGVJZCkge1xuICAgIHZvaWQgaGl0bEJyaWRnZS5oYW5kbGVQb3B1cFJlc29sdmUobXNnLmdhdGVJZCwgQm9vbGVhbihtc2cuYWNjZXB0KSwgbXNnLnByb21wdFRleHQpO1xuICAgIHNlbmRSZXNwb25zZSh7IG9rOiB0cnVlIH0pO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIC8vIERlYnVnIC8gdGVzdCBob29rOiBvcGVuIGEgZ2F0ZSBvbiBhIHRhYi5cbiAgaWYgKG1zZy5jbWQgPT09ICdoaXRsLW9wZW4nICYmIG1zZy5nYXRlICYmIHR5cGVvZiBtc2cudGFiSWQgPT09ICdudW1iZXInKSB7XG4gICAgdm9pZCBoaXRsQnJpZGdlLm9wZW5HYXRlKG1zZy5nYXRlLCBtc2cudGFiSWQpLnRoZW4oKCkgPT4gc2VuZFJlc3BvbnNlKHsgb2s6IHRydWUgfSkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgLy8gUG9wdXAg4oCUIGxpc3QgcGVuZGluZyBnYXRlcy5cbiAgaWYgKG1zZy5jbWQgPT09ICdoaXRsLWxpc3QnKSB7XG4gICAgc2VuZFJlc3BvbnNlKHsgb2s6IHRydWUsIGdhdGVzOiBoaXRsQnJpZGdlLmxpc3RQZW5kaW5nKCkgfSk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgLy8gTGVnYWN5IHdlYnNvY2tldCBjb25uZWN0IChyZXRhaW5lZCwgQGRlcHJlY2F0ZWQpLlxuICBpZiAobXNnLmNtZCA9PT0gJ2Nvbm5lY3QnICYmIG1zZy5ob3N0KSB7XG4gICAgdm9pZCBsZWdhY3lCcmlkZ2UuY29ubmVjdChtc2cuaG9zdCkudGhlbigoKSA9PiBzZW5kUmVzcG9uc2UoeyBvazogdHJ1ZSB9KSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICByZXR1cm4gZmFsc2U7XG59KTtcblxuLy8g4pSA4pSAIFRhYiBsaWZlY3ljbGU6IGRyb3AgY2FjaGVkIGluamVjdGlvbiBzdGF0ZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmNocm9tZS50YWJzLm9uUmVtb3ZlZC5hZGRMaXN0ZW5lcigodGFiSWQpID0+IHtcbiAgY29udGVudEVuZ2luZS5mb3JnZXQodGFiSWQpO1xuICBvdmVybGF5LmZvcmdldCh0YWJJZCk7XG4gIHZvaWQgZGVidWdnZXJNZ3IuZGV0YWNoKHRhYklkKTtcbn0pO1xuY2hyb21lLnRhYnMub25VcGRhdGVkLmFkZExpc3RlbmVyKCh0YWJJZCwgY2hhbmdlSW5mbykgPT4ge1xuICBpZiAoY2hhbmdlSW5mby5zdGF0dXMgPT09ICdsb2FkaW5nJykge1xuICAgIGNvbnRlbnRFbmdpbmUuZm9yZ2V0KHRhYklkKTtcbiAgICBvdmVybGF5LmZvcmdldCh0YWJJZCk7XG4gIH1cbn0pO1xuXG52b2lkIGxvYWRQZXJzaXN0ZWRTdGF0ZSgpO1xuXG4vLyBFeHBvcnRlZCBmb3IgdGVzdHMgLyBwb3B1cCBpbnNwZWN0aW9uIHZpYSBnbG9iYWxUaGlzIGluIHRoZSBTVyBzY29wZS5cbihzZWxmIGFzIHVua25vd24gYXMgeyBfX293ZWlibz86IHVua25vd24gfSkuX19vd2VpYm8gPSB7XG4gIG5hdGl2ZUJyaWRnZSwgbGVnYWN5QnJpZGdlLCBoaXRsQnJpZGdlLCBjb250ZW50RW5naW5lLCBkZWJ1Z2dlck1nciwgY29vcmRpbmF0b3IsXG4gIGV4ZWN1dGVBY3Rpb24sXG59O1xuXG4vLyBTaWxlbmNlIHVudXNlZC1pbXBvcnQgd2FybmluZ3Mg4oCUIEJyaWRnZU1lc3NhZ2UgaXMgdXNlZCBieSBsZWdhY3kgV1MgcGFyc2luZy5cbnR5cGUgX0JyaWRnZU1lc3NhZ2UgPSBCcmlkZ2VNZXNzYWdlO1xuLy8gU2lsZW5jZSB1bnVzZWQtaW1wb3J0IHdhcm5pbmcgZm9yIEdhdGVSZXNvbHV0aW9uICh1c2VkIGJ5IGlubGluZSB0eXBlcyBhYm92ZSkuXG50eXBlIF9HYXRlUmVzb2x1dGlvbiA9IEdhdGVSZXNvbHV0aW9uO1xuIl0sIm5hbWVzIjpbXSwic291cmNlUm9vdCI6IiJ9