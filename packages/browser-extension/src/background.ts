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

import { NativeMessagingBridge } from './bridge/NativeMessagingBridge.js';
import { ExtensionBridgeServer } from './bridge/ExtensionBridgeServer.js';
import { ExtensionHITLBridge } from './bridge/ExtensionHITLBridge.js';
import { ContentScriptActionEngine } from './content/ContentScriptActionEngine.js';
import { DebuggerLifecycleManager } from './content/DebuggerLifecycleManager.js';
import { DesktopNotificationFallback } from './hitl/DesktopNotificationFallback.js';
import { HITLSurfaceCoordinator, type ResolvedGateSink } from './hitl/HITLSurfaceCoordinator.js';
import { InTabHITLOverlay } from './hitl/InTabHITLOverlay.js';
import { routeFor, type BrowserAction, type GateResolution, type HITLGate } from './shared/actions.js';
import type { BridgeMessage } from './shared/protocol.js';

// ── Component graph ────────────────────────────────────────────────────────────
const nativeBridge  = new NativeMessagingBridge();
const legacyBridge  = new ExtensionBridgeServer();   // @deprecated — websocket mode only
const contentEngine = new ContentScriptActionEngine();
const debuggerMgr   = new DebuggerLifecycleManager('lazy');
const overlay       = new InTabHITLOverlay();
const notification  = new DesktopNotificationFallback();

// Sink forwards overlay/popup/notification resolutions back through whichever
// transport is active as an `extension-hitl-respond` action.
const gateSink: ResolvedGateSink = {
  async onResolved(r: GateResolution) {
    try {
      if (nativeBridge.isConnected()) {
        await nativeBridge.sendAction(crypto.randomUUID(), {
          type: 'extension-hitl-respond',
          gateId: r.gateId,
          accept: r.accept,
          promptText: r.promptText,
        });
      } else if (legacyBridge.isConnected()) {
        legacyBridge.sendGateResolved(r.gateId, r.accept);
      }
    } catch (e) {
      console.warn('[oweibo-hitl] sink send failed:', (e as Error).message);
    }
  },
};

const coordinator = new HITLSurfaceCoordinator(overlay, notification, gateSink);

// HITLBridge encapsulates all gate open/resolve/list logic and badge management.
const hitlBridge = new ExtensionHITLBridge({
  coordinator,
  nativeBridge,
  legacyBridge,
});

// ── State ──────────────────────────────────────────────────────────────────────
let sessionToken: string | null = null;
const BRIDGE_MODE_KEY = 'extensionBridgeMode';

async function loadPersistedState(): Promise<void> {
  const stored = await chrome.storage.local.get(['sessionToken', BRIDGE_MODE_KEY]);
  sessionToken = (stored['sessionToken'] as string | undefined) ?? null;
  const mode = (stored[BRIDGE_MODE_KEY] as 'native' | 'websocket' | undefined) ?? 'native';
  if (sessionToken && mode === 'native') {
    nativeBridge.connect(sessionToken);
  }
}

// ── Action dispatch ────────────────────────────────────────────────────────────
async function executeAction(tabId: number, action: BrowserAction): Promise<unknown> {
  const route = routeFor(action.type);

  if (route === 'cookies') {
    return executeCookieAction(action);
  }

  if (route === 'debugger') {
    return debuggerMgr.withDebugger(tabId, async () => {
      const cdp = action.cdp as { method: string; params?: Record<string, unknown> } | undefined;
      if (!cdp) throw new Error(`debugger route missing cdp payload for ${action.type}`);
      return chrome.debugger.sendCommand({ tabId }, cdp.method, cdp.params);
    });
  }

  // 38 content-script actions
  const result = await contentEngine.dispatch(tabId, action);
  if (!result.success) throw new Error(result.error ?? 'content script failed');
  return result.data;
}

async function executeCookieAction(action: BrowserAction): Promise<unknown> {
  switch (action.type) {
    case 'get-cookies': {
      const domain = action.domain as string | undefined;
      const cookies = await chrome.cookies.getAll(domain ? { domain } : {});
      return cookies;
    }
    case 'clear-cookies': {
      const domain = action.domain as string | undefined;
      const cookies = await chrome.cookies.getAll(domain ? { domain } : {});
      await Promise.all(cookies.map(c =>
        chrome.cookies.remove({
          url: `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path}`,
          name: c.name,
        }),
      ));
      return { cleared: cookies.length };
    }
    case 'set-cookies': {
      const list = (action.cookies as chrome.cookies.SetDetails[]) ?? [];
      await Promise.all(list.map(c => chrome.cookies.set(c)));
      return { set: list.length };
    }
    case 'import-cookies': {
      const domain = action.domain as string;
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
  await hitlBridge.openGate(
    { gateId: gate.gateId, type: gate.type, message: gate.message },
    tabId,
  );
});

// ── Legacy WS bridge: action and gate handlers ────────────────────────────────
legacyBridge.onAction(async (action, callId, tabId) => {
  return executeAction(tabId, action);
});
legacyBridge.onGate(async (gate, tabId) => {
  await hitlBridge.openGate(gate, tabId);
});

// ── Runtime messages (overlay → background, popup → background) ───────────────
chrome.runtime.onMessage.addListener((msg: {
  __oweiboHitlResolve?: boolean;
  gateId?: string;
  accept?: boolean;
  promptText?: string;
  cmd?: string;
  pairToken?: string;
  host?: string;
  gate?: HITLGate;
  tabId?: number;
}, _sender, sendResponse) => {
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
      nativeBridge.connect(msg.pairToken!);
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
(self as unknown as { __oweibo?: unknown }).__oweibo = {
  nativeBridge, legacyBridge, hitlBridge, contentEngine, debuggerMgr, coordinator,
  executeAction,
};

// Silence unused-import warnings — BridgeMessage is used by legacy WS parsing.
type _BridgeMessage = BridgeMessage;
// Silence unused-import warning for GateResolution (used by inline types above).
type _GateResolution = GateResolution;
