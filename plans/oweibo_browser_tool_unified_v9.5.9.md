# oweibo — BrowserTool: Unified Implementation Plan v9.5.9

> **Revision History**
>
> **v9.5.9 (this document):** Closes the six Manus Browser Operator parity gaps and
> replaces the terminal/popup HITL split with a unified three-surface gate system.
> **(1) `ContentScriptActionEngine`** — 38 of 54 actions now route through a content
> script that produces `isTrusted: true` DOM events, eliminating CDP timing fingerprints
> for all interaction-class actions. 13 page-level ops retain `chrome.debugger`. 3 new
> actions (`import-cookies`, `autofill-credentials`, `extension-hitl-respond`).
> **(2) `NativeMessagingBridge`** replaces `ExtensionBridgeServer` as the default
> transport — Chrome-managed stdio pipe, zero port binding, zero server process.
> `ExtensionBridgeServer` retained with `@deprecated`; selectable via
> `extensionBridgeMode` config.
> **(3) `DebuggerLifecycleManager`** with `extensionDebuggerPolicy: 'lazy'` (default)
> — `chrome.debugger` attached only for page-level actions and detached immediately
> after; yellow banner absent for content-script-only flows.
> **(4) Deep-link pairing** replaces 6-char code entry — CLI opens
> `chrome-extension://[id]/pair.html?token=…` directly in the user's browser; one
> click completes pairing.
> **(5) `BrowserSessionRouter`** + `auto` backend type — consults extension connection
> status, persistent profile availability, stealth pool, and `DomainReputationStore`
> to select the optimal backend automatically; `auto` is now the CLI default.
> **(6) Unified HITL surface** — `HITLSurfaceCoordinator` fans every gate to three
> surfaces simultaneously: terminal (unchanged), extension popup gate card (new),
> and `InTabHITLOverlay` — a floating panel injected into the active tab so the user
> sees the gate wherever they are looking. `DesktopNotificationFallback` fires an OS
> system notification when the tab is backgrounded. First response on any surface wins;
> all others dismiss instantly. 2 new events (total: **46**). 3 new action files, 7
> new extension files, 2 new `browser-tool` files. 8 surgical edits to existing files.
>
> No changes to the factory pipeline, swarm, compliance infrastructure, channel gateway,
> or skill registry core logic.
>
> **v9.5.8:** Closes the consumer UX gap. Adds `ChromeExtensionBackend`: Manifest V3
> Chrome extension using `chrome.debugger`. 0 new actions (total: 51), 1 new backend,
> 1 new package (`browser-extension`), 3 new contract types, 3 new events (total: 44).
>
> **v9.5.7:** Adds `PersistentProfileBackend` and `StealthProfilePool`. 0 new actions,
> 4 new sub-systems, 5 new contract types, 4 new events (total: 41).
>
> **v9.5.6:** Adds `UserChromeBackend`, `DomainReputationStore`, `BrowserCredentialStore`,
> `inject-credentials`. 1 new action (total: 51), 3 new sub-systems, 5 new contract
> types, 4 new events (total: 37).
>
> **v9.5.5:** 7 new actions (total: 50), 3 new sub-systems, 1 new service, headful mode,
> 9 new contract types, 6 new events (total: 33).
>
> **v9.5.4:** 14 new actions (total: 43), 3 new sub-systems, 7 new contract types,
> 8 new events (total: 27).
>
> **v9.5.3:** 25-gap surgical patch. 9 new files, 30 edits.
>
> **v9.5.2:** 7 targeted fixes.
>
> **v9.5:** Browser as a First-Class Agent Skill. 28 actions, persistent sessions,
> vision loop, stealth, cloud backends, multi-tenant isolation.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Gap Closure Map](#2-gap-closure-map)
3. [Package Structure](#3-package-structure)
4. [Core Contracts](#4-core-contracts)
5. [BrowserSessionManager](#5-browsersessionmanager)
6. [BrowserTool — 54 Atomic Actions](#6-browsertool--54-atomic-actions)
7. [BrowserVisionBridge](#7-browservisionbridge)
8. [Stealth and Anti-Bot Layer](#8-stealth-and-anti-bot-layer)
9. [BrowserEventStreamer](#9-browsereventstreamer)
10. [Integration with Existing Architecture](#10-integration-with-existing-architecture)
11. [CLI Extension — `oweibo browser` Commands](#11-cli-extension--oweibo-browser-commands)
12. [Security Hardening](#12-security-hardening)
13. [Dependency Graph and Cruiser Rules](#13-dependency-graph-and-cruiser-rules)
14. [Configuration and Vault Paths](#14-configuration-and-vault-paths)
15. [Surgical Edits to Existing Files](#15-surgical-edits-to-existing-files)
16. [Testing Strategy](#16-testing-strategy)
17. [Rollout Plan](#17-rollout-plan)
18. [Capability Comparison (Post v9.5.9)](#18-capability-comparison-post-v959)

---

## 1. Executive Summary

Oweibo v9.5.9 is the most capable and secure autonomous browser agent available. Every
agent — CLI, Telegram, Discord, Slack, or any channel from v9.3 — gains:

- **54 atomic actions** covering the full range of human web interaction.
- **`isTrusted: true` DOM events** for all 38 interaction-class actions via
  `ContentScriptActionEngine` — indistinguishable from human gestures by anti-bot systems.
- **No CDP fingerprint** for interaction flows: `chrome.debugger` is attached only for the
  13 page-level ops that require it, and only for the duration of that single action
  (`extensionDebuggerPolicy: 'lazy'`). The yellow debugger banner is absent for
  content-script-only flows.
- **Native messaging transport** (`NativeMessagingBridge`) — Chrome-managed stdio pipe,
  no port, no server process, no OS firewall to traverse.
- **One-click pairing** — CLI opens the extension pairing page as a deep link; the user
  clicks Connect once and never enters a code again.
- **Automatic backend selection** (`BrowserSessionRouter` + `auto` backend) — the system
  picks the optimal backend based on extension connection, profile availability, and domain
  reputation. Users never need to specify `--backend` explicitly.
- **Graduated authentication ladder**: `import-cookies` (zero setup, uses Chrome's real
  cookies) → `autofill-credentials` (Chrome password manager, agent never sees values) →
  `inject-credentials` (Vault-backed AES-256-GCM) → HITL (human logs in manually).
- **Unified HITL surface** — gates appear simultaneously in the terminal, the extension
  popup, and a floating panel injected directly into the active browser tab. OS desktop
  notifications fire when the tab is backgrounded. The first surface to receive a response
  resolves the gate; all others dismiss instantly.
- Full persistent sessions, vision loop with cost gating and history summarisation,
  drag-and-drop, iframe/shadow DOM, network interception, video recording, HAR export,
  device emulation, accessibility tree, console/network log capture, DLP redaction,
  screenshot watermarking, browser extension loading, cross-task session sharing, headful
  debug mode, and a Browser MCP server — carried forward verbatim from v9.5.4–v9.5.8.
- Per-tenant isolation, audit logging, HITL gates, session concurrency limits, idle context
  cleanup, and ClamAV auto-refresh — all unchanged from earlier revisions.

**Total actions: 54.** **Total browser events: 46.**

---

## 2. Gap Closure Map

### v9.5.9 Gap Closure

| Gap | Root Cause in v9.5.8 | Closed By | Section |
|---|---|---|---|
| DOM action detectability via CDP | All 51 actions routed through `chrome.debugger`; CDP timing fingerprints detectable by PerimeterX/DataDome | `ContentScriptActionEngine` — 38 actions via content script (`isTrusted: true`); 13 page-level ops retain debugger | §8.8 |
| WebSocket bridge indirection | `ExtensionBridgeServer` on `ws://localhost:7731`; port + process to manage | `NativeMessagingBridge` — Chrome stdio pipe; no port, no server process | §8.9 |
| Persistent yellow debugger banner | `chrome.debugger` held for entire session lifetime | `extensionDebuggerPolicy: 'lazy'` — attach only during page-level action, detach immediately after | §8.10 |
| 6-char code pairing friction | Terminal shows code; user must open popup and type it | Deep-link pairing — CLI opens `chrome-extension://[id]/pair.html?token=…`; one click pairs | §8.10 |
| Credential / session setup friction | `inject-credentials` requires upfront Vault setup; barrier for solo users | `import-cookies` (Chrome cookies, zero Vault setup) + `autofill-credentials` (Chrome password manager) | §6.22, §6.23 |
| Manual backend selection | Users must choose `--backend` explicitly on every session | `BrowserSessionRouter` + `auto` backend type; `auto` is new CLI default | §5.20 |
| Terminal-only HITL for extension users | Gate events emitted to terminal only; extension users see tab freeze with no explanation | `HITLSurfaceCoordinator` + `InTabHITLOverlay` (in-tab floating panel) + `DesktopNotificationFallback` (OS notification when tab backgrounded) | §8.11 |

### v9.5.8 Gap Closure

| Gap | Root Cause in v9.5.7 | Closed By | Section |
|---|---|---|---|
| Local browser requires `--remote-debugging-port` flag | `UserChromeBackend` not usable by non-technical users | `ChromeExtensionBackend`: one-click Web Store install | §8.7 |
| No zero-friction onboarding | All local-browser modes require developer knowledge | Deep-link pairing + HMAC auto-reconnect | §8.10 |

### v9.5.7 Gap Closure

| Gap | Closed By | Section |
|---|---|---|
| Persistent profiles (Camofox parity) | `PersistentProfileBackend` + `IProfileStore` | §8.5 |
| Pre-warmed aged stealth personas | `StealthProfilePool` + `PersonaLibrary` + `ProfileWarmer` | §8.6 |

### v9.5.6 Gap Closure

| Gap | Closed By | Section |
|---|---|---|
| No local CDP attachment | `UserChromeBackend` | §8.4 |
| Reactive-only anti-bot routing | `DomainReputationStore` pre-classifier | §5.15, §8.2 |
| No agent credential management | `BrowserCredentialStore` + `inject-credentials` | §5.14, §6.21 |

### v9.5.4 & v9.5.5 Gap Closure

| Gap | Closed By |
|---|---|
| Dialog handling | `DialogManager` + `handle-dialog` |
| Drag & drop / mouse | `drag-and-drop`, `mouse-move/down/up` |
| Iframe / Shadow DOM | `switch-to-frame`, `switch-to-main` |
| Network interception | `intercept-request`, `mock-response`, `remove-intercept` |
| Video recording | `record-video-start/stop` |
| HAR export | `har-start/stop` |
| Device emulation | `emulate-device` |
| Accessibility tree | `accessibility-snapshot` |
| Console/network logs | `log-capture-start/stop` |
| Keyboard shortcuts | `key-chord` |
| Geolocation/permissions | `set-geolocation`, `grant-permissions`, `revoke-permissions` |
| Print-to-PDF | `print-to-pdf` |
| Extension loading | `load-extension` |
| Session sharing | `share-session` |
| DLP redaction | `BrowserDlpFilter` |
| Screenshot watermarking | `ScreenshotWatermarker` |
| Browser as MCP server | `BrowserMcpServer` |
| Headful debug mode | `headful` flag |

---

## 3. Package Structure

```
packages/
  browser-tool/
    src/
      contracts/
        IBrowserTool.ts
        IBrowserBackend.ts
        IBrowserContentPolicy.ts
        errors.ts                      ← all 8 custom error classes + BrowserSessionLimitError
      session/
        BrowserSessionManager.ts       ← concurrency guards, inflight lock, frame stack,
                                          auto-backend delegation to BrowserSessionRouter (v9.5.9)
        BrowserTabRegistry.ts
        SessionSnapshotStore.ts
        SessionReaper.ts
        DialogManager.ts
        DialogAutoPolicy.ts
        NetworkInterceptRegistry.ts
        BrowserLogCollector.ts
        BrowserDlpFilter.ts
        BrowserExtensionRegistry.ts
        ScreenshotWatermarker.ts
        BrowserCredentialStore.ts
        DomainReputationStore.ts
        ProfileStore.ts
        BrowserSessionRouter.ts        ← NEW v9.5.9 — 'auto' backend signal-aware selection
      tool/
        BrowserTool.ts
        BrowserPromptBudget.ts
        BrowserActionSchema.ts         ← Zod schema for all 54 actions
        actions/
          NavigateAction.ts
          ClickAction.ts
          TypeAction.ts
          ScrollAction.ts
          HoverAction.ts
          SelectAction.ts
          CheckAction.ts
          WaitAction.ts
          WaitForSelectorAction.ts
          SubmitAction.ts
          ScreenshotAction.ts
          SnapshotAction.ts
          ExtractAction.ts
          EvalAction.ts
          TabOpenAction.ts
          TabSwitchAction.ts
          TabCloseAction.ts
          TabsListAction.ts
          GoBackAction.ts
          GoForwardAction.ts
          ReloadAction.ts
          ClearCookiesAction.ts
          GetCookiesAction.ts
          SetCookiesAction.ts
          UploadAction.ts
          DownloadAction.ts
          MoveToUploadAction.ts
          GetUrlAction.ts
          GetTitleAction.ts
          HandleDialogAction.ts
          DragAndDropAction.ts
          MouseMoveAction.ts
          MouseDownAction.ts
          MouseUpAction.ts
          SwitchToFrameAction.ts
          SwitchToMainAction.ts
          InterceptRequestAction.ts
          MockResponseAction.ts
          RemoveInterceptAction.ts
          RecordVideoStartAction.ts
          RecordVideoStopAction.ts
          HarStartAction.ts
          HarStopAction.ts
          EmulateDeviceAction.ts
          AccessibilitySnapshotAction.ts
          LogCaptureStartAction.ts
          LogCaptureStopAction.ts
          KeyChordAction.ts
          SetGeolocationAction.ts
          GrantPermissionsAction.ts
          RevokePermissionsAction.ts
          PrintToPdfAction.ts
          LoadExtensionAction.ts
          ShareSessionAction.ts
          InjectCredentialsAction.ts
          ImportCookiesAction.ts         ← NEW v9.5.9
          AutofillCredentialsAction.ts   ← NEW v9.5.9
      vision/
        BrowserVisionBridge.ts
        VisionPromptBuilder.ts
        ActionSelector.ts
      stealth/
        StealthPlugin.ts
        UserAgentRotator.ts
        BrowserBackendRouter.ts
        backends/
          LocalPlaywrightBackend.ts
          BrowserbaseBackend.ts
          BrightDataBackend.ts
          UserChromeBackend.ts
          PersistentProfileBackend.ts
          ChromeExtensionBackend.ts      ← updated: delegates to NativeMessagingBridge (v9.5.9)
      streaming/
        BrowserEventStreamer.ts
      policy/
        BrowserContentPolicy.ts
        SafeBrowsingClient.ts
        ClamAvFreshnessJob.ts
      skill/
        BrowserSkillActionParser.ts
      cli/
        BrowserCLICommands.ts
      index.ts

  browser-extension/                    ← Manifest V3 Chrome extension (v9.5.8+)
    src/
      bridge/
        ExtensionBridgeServer.ts        ← @deprecated — retained for websocket mode
        NativeMessagingBridge.ts        ← NEW v9.5.9 — default transport
        ExtensionHITLBridge.ts          ← UPDATED v9.5.9 — delegates to HITLSurfaceCoordinator
      content/
        ContentScriptActionEngine.ts    ← NEW v9.5.9 — dispatches DOM actions to content script
        DebuggerLifecycleManager.ts     ← NEW v9.5.9 — lazy attach/detach policy
        content-script.ts              ← NEW v9.5.9 — compiled to content-script.js
        hitl-overlay.ts               ← NEW v9.5.9 — compiled to hitl-overlay.js; in-tab panel
      hitl/
        HITLSurfaceCoordinator.ts      ← NEW v9.5.9 — single gate lifecycle authority
        InTabHITLOverlay.ts            ← NEW v9.5.9 — background script side: show/dismiss overlay
        DesktopNotificationFallback.ts ← NEW v9.5.9 — OS notifications for backgrounded tabs
      actions/
        ImportCookiesAction.ts         ← NEW v9.5.9 — uses chrome.cookies via bridge
      manifest.json
      popup.html / popup.ts
      background.ts
      pair.html                        ← NEW v9.5.9 — deep-link pairing page
      esbuild.config.js
```

---

## 4. Core Contracts

### 4.1 `BrowserAction` Union (54 actions total)

```typescript
// packages/core-contracts/src/browser.ts

export type BrowserActionType =
  // Navigation (7)
  | 'navigate' | 'go-back' | 'go-forward' | 'reload' | 'get-url' | 'get-title' | 'emulate-device'
  // Interaction (12)
  | 'click' | 'type' | 'scroll' | 'hover' | 'select' | 'check' | 'wait'
  | 'wait-for-selector' | 'submit' | 'drag-and-drop' | 'mouse-move' | 'mouse-down' | 'mouse-up'
  // Extraction (3)
  | 'screenshot' | 'snapshot' | 'extract'
  // Tabs (4)
  | 'tab-open' | 'tab-switch' | 'tab-close' | 'tabs-list'
  // Frames (2)
  | 'switch-to-frame' | 'switch-to-main'
  // Files (3)
  | 'upload' | 'download' | 'move-to-upload'
  // Cookies (3)
  | 'clear-cookies' | 'get-cookies' | 'set-cookies'
  // Auth & Credentials (3)
  | 'inject-credentials' | 'import-cookies' | 'autofill-credentials'
  // Utility (3)
  | 'eval' | 'key-chord' | 'handle-dialog'
  // Network (3)
  | 'intercept-request' | 'mock-response' | 'remove-intercept'
  // Recordings (4)
  | 'record-video-start' | 'record-video-stop' | 'har-start' | 'har-stop'
  // Observability (3)
  | 'log-capture-start' | 'log-capture-stop' | 'accessibility-snapshot'
  // Browser (5)
  | 'print-to-pdf' | 'load-extension' | 'share-session'
  | 'set-geolocation' | 'grant-permissions' | 'revoke-permissions'
  // HITL internal (1)
  | 'extension-hitl-respond';

export type BrowserAction =
  // — All existing variants from v9.5.8 unchanged —
  | { type: 'navigate'; url: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }
  | { type: 'click'; selector: string; button?: 'left'|'right'|'middle'; clickCount?: number }
  | { type: 'type'; selector: string; text: string; delay?: number; clearFirst?: boolean }
  | { type: 'scroll'; selector?: string; direction: 'up'|'down'|'left'|'right'; distance?: number }
  | { type: 'hover'; selector: string }
  | { type: 'select'; selector: string; value: string | string[] }
  | { type: 'check'; selector: string; checked: boolean }
  | { type: 'wait'; ms: number }
  | { type: 'wait-for-selector'; selector: string; state?: 'visible'|'hidden'|'attached'|'detached'; timeout?: number }
  | { type: 'submit'; selector: string }
  | { type: 'screenshot'; fullPage?: boolean; element?: string }
  | { type: 'snapshot' }
  | { type: 'extract'; selectors: { name: string; query: string; attribute?: string }[] }
  | { type: 'eval'; expression: string }
  | { type: 'tab-open'; url?: string }
  | { type: 'tab-switch'; tabId: string }
  | { type: 'tab-close'; tabId: string }
  | { type: 'tabs-list' }
  | { type: 'go-back' } | { type: 'go-forward' } | { type: 'reload' }
  | { type: 'get-url' } | { type: 'get-title' }
  | { type: 'clear-cookies'; domain?: string }
  | { type: 'get-cookies'; domain?: string }
  | { type: 'set-cookies'; cookies: BrowserCookie[] }
  | { type: 'upload'; selector: string; filePath: string }
  | { type: 'download'; url: string; filename?: string }
  | { type: 'move-to-upload'; sourcePath: string; filename?: string }
  | { type: 'handle-dialog'; accept: boolean; promptText?: string }
  | { type: 'drag-and-drop'; sourceSelector: string; targetSelector: string; steps?: number }
  | { type: 'mouse-move'; x: number; y: number }
  | { type: 'mouse-down'; x: number; y: number; button?: 'left'|'right'|'middle' }
  | { type: 'mouse-up'; x: number; y: number; button?: 'left'|'right'|'middle' }
  | { type: 'switch-to-frame'; frameSelector: string }
  | { type: 'switch-to-main' }
  | { type: 'intercept-request'; urlPattern: string; resourceTypes?: string[]; interceptId: string }
  | { type: 'mock-response'; interceptId: string; status: number; body: string; contentType?: string }
  | { type: 'remove-intercept'; interceptId: string }
  | { type: 'record-video-start'; filename?: string }
  | { type: 'record-video-stop' }
  | { type: 'har-start'; filename?: string }
  | { type: 'har-stop' }
  | { type: 'emulate-device'; deviceName: string }
  | { type: 'accessibility-snapshot'; includeHidden?: boolean }
  | { type: 'log-capture-start'; includeNetworkBodies?: boolean }
  | { type: 'log-capture-stop' }
  | { type: 'key-chord'; keys: string[] }
  | { type: 'set-geolocation'; latitude: number; longitude: number; accuracy?: number }
  | { type: 'grant-permissions'; permissions: BrowserPermission[]; origin?: string }
  | { type: 'revoke-permissions'; origin?: string }
  | { type: 'print-to-pdf'; options?: { format?: string; margin?: Record<string, string> } }
  | { type: 'load-extension'; extensionId: string }
  | { type: 'share-session'; ttlSeconds?: number }
  | { type: 'inject-credentials'; serviceId: string; submitAfterFill?: boolean; usernameSelector?: string; passwordSelector?: string }
  // ── v9.5.9 additions ────────────────────────────────────────────────────────
  | { type: 'import-cookies'; domain: string }
  | { type: 'autofill-credentials'; usernameSelector?: string; submitAfterFill?: boolean }
  | { type: 'extension-hitl-respond'; gateId: string; accept: boolean; promptText?: string };
```

### 4.2 `BrowserSessionConfig` (complete — v9.5.9)

```typescript
export interface BrowserSessionConfig {
  tenantId: string;
  sessionId: string;
  taskId: string;
  backend: 'auto' | 'local' | 'browserbase' | 'brightdata' | 'userchrome'
         | 'persistent' | 'extension';   // 'auto' new in v9.5.9
  locale?: string;
  timezoneId?: string;
  storageState?: string;
  browserbaseProjectId?: string;
  brightDataZone?: string;
  egressProxy?: { server: string; username: string; password: string };
  viewport?: { width: number; height: number };
  cdpEndpoint?: string;
  credentialRef?: string;
  persistentProfileId?: string;
  useStealthPool?: boolean;
  headful?: boolean;
  extensionDebuggerPolicy?: 'persistent' | 'lazy';  // NEW v9.5.9 — default 'lazy'
  extensionBridgeMode?: 'websocket' | 'native';      // NEW v9.5.9 — default 'native'
}
```

### 4.3 `ISecurityContext` additions (v9.5.9)

```typescript
// Added to existing ISecurityContext:
allowCookieImport: boolean;   // import-cookies; default true autonomous / false supervised
allowAutofill: boolean;       // autofill-credentials; default true all modes
```

### 4.4 `HITLGate` type (NEW v9.5.9)

```typescript
export interface HITLGate {
  gateId: string;
  type: 'dialog' | 'vision-loop';
  message: string;
  dialogType?: BrowserDialogType;
}
```

### 4.5 Other contract types

All supporting types from v9.5.3–v9.5.8 are unchanged: `BrowserCookie`,
`PageSnapshot`, `BrowserActionResult` (with `snapshot?`, `accessibilityTree?`,
`logSnapshot?`, `pdfResult?`), `BrowserSession`, `BrowserTabState`,
`BrowserVisionResult`, `BrowserDownloadResult`, `IPromptBudgetCollaborator`,
`IWarmPool`/`IWarmContainer` extensions, error classes, `AccessibilityNode`,
`BrowserLogSnapshot`, `BrowserPdfResult`, `BrowserPermission`,
`BrowserExtensionDescriptor`, `BrowserSessionShareToken`, `ScreenshotWatermarkMetadata`,
`DlpCategory`, `BrowserCredential`, `EncryptedCredential`, `DomainReputation`,
`IProfileStore`, `StealthPersona`, `ExtensionBridgeCommand`, `ExtensionBridgeResult`.

---

## 5. BrowserSessionManager

### 5.1–5.6 (unchanged from v9.5.8)

Session lifecycle, `BrowserTabRegistry`, `SessionReaper`, worker-restart resilience,
Redis state schema, concurrency guards, inflight lock, migration drain phase — all
unchanged.

### 5.20 `BrowserSessionRouter` — `auto` backend (NEW v9.5.9)

`BrowserSessionRouter` is consulted when `config.backend === 'auto'` and selects the
optimal backend by examining all available signals.

```typescript
// packages/browser-tool/src/session/BrowserSessionRouter.ts

export type BackendCandidate =
  'local' | 'persistent' | 'extension' | 'userchrome' | 'browserbase' | 'brightdata';

export interface RoutingContext {
  tenantId: string;
  targetUrl: string;
  securityContext: ISecurityContext;
  extensionConnected: boolean;        // paired extension session available?
  persistentProfileExists: boolean;   // profile exists for this tenant?
  stealthPoolAvailable: boolean;      // pool has ≥ 1 available profile?
  taskHint?: 'research' | 'checkout' | 'auth' | 'form';
}

export class BrowserSessionRouter {
  async selectBackend(ctx: RoutingContext): Promise<BackendCandidate> {
    const domain = new URL(ctx.targetUrl).hostname;
    const tier = await this.reputationStore.getTier(domain);

    if (tier === 'cloud-required') return this.selectCloud(ctx);

    // Paired extension: highest trust signal — real cookies, real IP, real browser
    if (ctx.extensionConnected && ctx.securityContext.allowExtensionBridge) {
      return 'extension';
    }

    // Auth/checkout: persistent profile gives IndexedDB + SW persistence
    if (['auth', 'checkout'].includes(ctx.taskHint ?? '') && ctx.persistentProfileExists
        && ctx.securityContext.allowPersistentProfile) {
      return 'persistent';
    }

    // Cloudflare-heavy or bot-sensitive: stealth pool
    if (tier === 'cloud-preferred' && ctx.stealthPoolAvailable
        && ctx.securityContext.allowPersistentProfile) {
      return 'persistent'; // useStealthPool: true
    }

    return 'local';
  }

  private selectCloud(ctx: RoutingContext): BackendCandidate {
    return ctx.securityContext.allowBrightData ? 'brightdata' : 'browserbase';
  }
}
```

**Integration in `BrowserSessionManager.createSession()`:**

```typescript
if (config.backend === 'auto') {
  config.backend = await this.sessionRouter.selectBackend({
    tenantId: config.tenantId,
    targetUrl: options.initialUrl ?? '',
    securityContext: options.securityContext,
    extensionConnected: this.bridge.hasActiveSession(config.tenantId),
    persistentProfileExists: await this.profileStore.exists(config.tenantId),
    stealthPoolAvailable: (await this.stealthPool.availableCount()) > 0,
    taskHint: options.taskHint,
  });
  this.emitter.emit('browser-backend-auto-selected', {
    tenantId: config.tenantId, sessionId: config.sessionId, selected: config.backend,
  });
}
```

---

## 6. BrowserTool — 54 Atomic Actions

### 6.1–6.21 (unchanged from v9.5.8)

All 51 actions from v9.5.8 are unchanged. Sections 6.1–6.21 cover navigation,
interaction, extraction, tab management, frames, file actions, cookies, utility,
dialog, drag/mouse, network, recording, observability, keyboard, geolocation,
print, extension, session sharing, and credential injection.

### 6.22 `import-cookies` (NEW v9.5.9)

Extension-mode only. Uses `chrome.cookies.getAll({ domain })` via the HMAC-
authenticated bridge to read the user's real Chrome cookies and apply them to the
current session context. Zero Vault setup. Enables single-action authenticated
session bootstrap.

```typescript
// ImportCookiesAction.ts
async execute(action, context): Promise<BrowserActionResult> {
  if (!context.securityContext.allowCookieImport)
    throw new BrowserPolicyViolationError('import-cookies requires allowCookieImport: true.');

  const cookies = await this.bridge.sendAction(crypto.randomUUID(), {
    type: 'import-cookies', domain: action.domain,
  }) as BrowserCookie[];

  if (!cookies.length)
    return { success: false, actionType: 'import-cookies',
             observation: `No cookies found for "${action.domain}".`,
             error: 'NO_COOKIES_FOUND' };

  // Apply cookies to session context (extension sessions own their cookie store)
  await this.bridge.sendAction(crypto.randomUUID(), { type: 'set-cookies', cookies });

  // Audit: domain and count only — no values
  this.auditLogger.log({
    event: 'browser-cookies-imported',
    tenantId: context.tenantId, taskId: context.taskId,
    domain: action.domain, cookieCount: cookies.length,
  });
  context.eventEmitter.emit('browser-cookies-imported', {
    domain: action.domain, cookieCount: cookies.length,
    tenantId: context.tenantId, taskId: context.taskId,
  });

  return {
    success: true, actionType: 'import-cookies',
    observation: `Imported ${cookies.length} cookies for "${action.domain}". ` +
                 `Navigate to the site — session should be authenticated.`,
    data: { domain: action.domain, cookieCount: cookies.length },
  };
}
```

**Security:** Cookie values flow through the HMAC-authenticated bridge only. They
are never written to Redis, never appear in `observation` or `data` value fields,
and are filtered by `BrowserDlpFilter`. Audit records domain and count only.
Trust gate: `allowCookieImport` (default `true` autonomous / `false` supervised).
Extension popup shows a one-time consent banner on first use per domain.

### 6.23 `autofill-credentials` (NEW v9.5.9)

Extension-mode only. Triggers Chrome's native password manager autofill by
replicating the exact focus/keydown event sequence Chrome's autofill overlay listens
to. The agent never reads the filled values. Chrome prevents reading autofill-filled
passwords via `HTMLInputElement.value`.

```typescript
// content-script handler for autofill-credentials
case 'autofill-credentials': {
  const usernameEl =
    action.usernameSelector
      ? requireElement(action.usernameSelector)
      : document.querySelector(
          'input[type=email], input[name*="user" i], input[name*="email" i]');
  if (!usernameEl) return { success: false, error: 'USERNAME_FIELD_NOT_FOUND' };

  usernameEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  (usernameEl as HTMLElement).focus();
  usernameEl.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
  usernameEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  await sleep(800); // Chrome fills asynchronously

  const filled = (usernameEl as HTMLInputElement).value.length > 0;
  if (!filled) return {
    success: false, error: 'AUTOFILL_DID_NOT_TRIGGER',
    observation: 'Chrome autofill did not trigger. Ensure credentials are saved in Chrome for this site. Fallback: inject-credentials.',
  };

  if (action.submitAfterFill ?? true) {
    const form = (usernameEl as HTMLElement).closest('form');
    const btn = form?.querySelector('button[type=submit], input[type=submit], [role=button]');
    if (btn) (btn as HTMLElement).click(); else form?.requestSubmit();
  }

  return { success: true, actionType: 'autofill-credentials',
           observation: 'Chrome autofill triggered. Credentials filled from Chrome password manager. Agent never accessed credential values.' };
}
```

### 6.24 The Graduated Authentication Ladder

```
Authentication request for site.com
       │
       ▼
1. import-cookies(domain: 'site.com')
   → Already logged in? Done. Zero setup.
       │ Not logged in
       ▼
2. autofill-credentials(usernameSelector: ...)
   → Chrome password manager filled it? Done. Zero Vault setup.
       │ Autofill not available
       ▼
3. inject-credentials(serviceId: 'site.com')
   → Vault-backed AES-256-GCM. Requires one-time admin setup.
       │ No credentials stored
       ▼
4. HITL: emit browser-dialog-pending
   → Human logs in manually. Agent resumes from authenticated state.
```

`BrowserVisionBridge` is aware of this ladder: when the vision loop detects a login
page, it selects among the four strategies in order.

---

## 7. BrowserVisionBridge (unchanged from v9.5.8)

Active reasoning loop, cost gate, history summarisation, `resumeLoop()`, and
`VisionPromptBuilder` with `earlierSummary` injection are all unchanged from v9.5.8.

---

## 8. Stealth and Anti-Bot Layer

### 8.1–8.6 (unchanged from v9.5.8)

Local stealth, `BrowserBackendRouter`, CAPTCHA handling, `UserChromeBackend`,
`PersistentProfileBackend`, `StealthProfilePool` — all unchanged.

### 8.7 `ChromeExtensionBackend` (v9.5.8 baseline, updated in v9.5.9)

The `ChromeExtensionBackend` class itself is unchanged. In v9.5.9 its internal
transport (`ExtensionBridgeServer` WebSocket) is replaced by `NativeMessagingBridge`
as the default. Its pairing flow moves from code-entry to deep-link. All action
routing is updated via `ContentScriptActionEngine`. See §8.8–8.11.

### 8.8 `ContentScriptActionEngine` (NEW v9.5.9)

**Why CDP for DOM actions is detectable:** Modern anti-bot systems (PerimeterX,
DataDome, Akamai) fingerprint CDP synthetic events via sub-millisecond timing
precision, `isTrusted: false` on DOM events, and V8 call-stack depth from
`Runtime.evaluate` wrappers. A content script `element.click()` call produces
`isTrusted: true` events — identical to a real click.

**Architecture:**

```
Extension background.js
  │
  ├── [Page-level ops — 13] chrome.debugger.sendCommand(...)
  │     navigate, screenshot, eval, accessibility-snapshot,
  │     switch-to-frame, handle-dialog, intercept-request,
  │     log-capture-start/stop, key-chord, record-video-*, har-*
  │
  └── [DOM ops — 38] chrome.tabs.sendMessage(tabId, action)
              │
              ▼
          content-script.js (oweibo-content.js)
              │  element.click()            → isTrusted: true MouseEvent
              │  element.focus() + InputEvent → isTrusted: true
              └─ form.requestSubmit()       → isTrusted: true
```

**Action routing table (v9.5.9):**

| Action | Route in v9.5.8 | Route in v9.5.9 |
|---|---|---|
| `navigate` | `chrome.debugger` → `Page.navigate` | `chrome.debugger` (unchanged) |
| `click` | `chrome.debugger` → `Runtime.evaluate` → `el.click()` | content script → `el.click()` |
| `type` | `chrome.debugger` → `Input.dispatchKeyEvent` × N | content script → `el.focus(); el.value=…; dispatchEvent(InputEvent)` |
| `scroll` | `chrome.debugger` → `Runtime.evaluate` | content script → `el.scrollBy()` |
| `hover` | `chrome.debugger` → `Input.dispatchMouseEvent` | content script → `el.dispatchEvent(new MouseEvent('mouseover',…))` |
| `select` | `chrome.debugger` → `Runtime.evaluate` | content script → `el.value=…; dispatchEvent(new Event('change',…))` |
| `check` | `chrome.debugger` → `Runtime.evaluate` | content script → `el.checked=…; el.click()` |
| `wait` | `chrome.debugger` → `Runtime.evaluate` (sleep) | content script → `setTimeout` promise |
| `wait-for-selector` | `chrome.debugger` → `Runtime.evaluate` (polling) | content script → `MutationObserver` |
| `submit` | `chrome.debugger` → `Runtime.evaluate` | content script → `form.requestSubmit()` |
| `drag-and-drop` | `chrome.debugger` → `Input.dispatchMouseEvent` sequence | content script → `MouseEvent` sequence |
| `mouse-move/down/up` | `chrome.debugger` → `Input.dispatchMouseEvent` | content script → `MouseEvent` |
| `extract` | `chrome.debugger` → `Runtime.evaluate` | content script → `querySelectorAll` |
| `snapshot` | `chrome.debugger` → `Runtime.evaluate` | content script → DOM serialisation |
| `get-url` / `get-title` | `chrome.debugger` → `Runtime.evaluate` | content script → `window.location.href` / `document.title` |
| `upload` | `chrome.debugger` → `Runtime.evaluate` | content script → `DataTransfer` + `input.files` |
| `clear-cookies` | `chrome.debugger` → `Network.clearBrowserCookies` | `chrome.cookies.remove()` |
| `get-cookies` / `set-cookies` | `chrome.debugger` → `Network.*` | `chrome.cookies.*` |
| `import-cookies` | n/a | `chrome.cookies.getAll()` (new in v9.5.9) |
| `autofill-credentials` | n/a | content script → focus/keydown sequence (new in v9.5.9) |
| `screenshot` | `chrome.debugger` → `Page.captureScreenshot` | `chrome.debugger` (unchanged) |
| `eval` | `chrome.debugger` → `Runtime.evaluate` | `chrome.debugger` (unchanged — trust-gated) |
| `accessibility-snapshot` | `chrome.debugger` → `Accessibility.getFullAXTree` | `chrome.debugger` (unchanged) |
| `switch-to-frame` | `chrome.debugger` → `Page.getFrameTree` | `chrome.debugger` (unchanged) |
| `handle-dialog` | `chrome.debugger` → `Page.handleJavaScriptDialog` | `chrome.debugger` (unchanged) |
| `intercept-request` | `chrome.debugger` → `Fetch.enable` | `chrome.debugger` (unchanged) |
| `key-chord` | `chrome.debugger` → `Input.dispatchKeyEvent` | `chrome.debugger` (unchanged — OS-level key routing) |
| `record-video-*` / `har-*` | `chrome.debugger` | `chrome.debugger` (unchanged) |
| `log-capture-*` | `chrome.debugger` → `Runtime.enable` | `chrome.debugger` (unchanged) |

**Summary: 38 of 54 actions → content script. 13 → `chrome.debugger`. 3 new v9.5.9 actions use extension APIs directly.**

```typescript
// packages/browser-extension/src/content/ContentScriptActionEngine.ts
export class ContentScriptActionEngine {
  async dispatch(tabId: number, action: BrowserAction): Promise<ContentScriptResult> {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-script.js'] });
    return chrome.tabs.sendMessage(tabId, action);
  }
}
```

### 8.9 `NativeMessagingBridge` (NEW v9.5.9)

Replaces `ExtensionBridgeServer` WebSocket as the default transport.

| | `ExtensionBridgeServer` (v9.5.8) | `NativeMessagingBridge` (v9.5.9) |
|---|---|---|
| Transport | WebSocket on `ws://localhost:7731` | Chrome-managed stdio pipe |
| Port binding | Yes — can conflict; firewall may block | None |
| Server process | Separate; must be started first | Chrome launches on demand |
| Reconnect | HMAC over new WebSocket | Chrome reconnects automatically |
| Authentication | HMAC per message | HMAC per message (same scheme) |
| Failure mode | Port conflict, server crash, socket timeout | Chrome kills host on disconnect; clean |

`ExtensionBridgeServer` is retained with `@deprecated`. `extensionBridgeMode: 'websocket' | 'native'` on `BrowserSessionConfig` selects transport; default is `'native'` for new installations.

**Native host registration (one-time, no admin required on macOS/Linux):**

```bash
# macOS
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.oweibo.browser.json

# Linux
~/.config/google-chrome/NativeMessagingHosts/com.oweibo.browser.json
```

```typescript
// packages/browser-extension/src/bridge/NativeMessagingBridge.ts
export class NativeMessagingBridge {
  private port: chrome.runtime.Port | null = null;
  private readonly pendingCalls = new Map<string, (r: unknown) => void>();

  connect(hmacToken: string): void {
    this.port = chrome.runtime.connectNative('com.oweibo.browser');
    this.port.onMessage.addListener(msg => this.handleIncoming(msg, hmacToken));
    this.port.onDisconnect.addListener(() => { this.port = null; });
  }

  async sendAction(callId: string, action: BrowserAction): Promise<unknown> {
    return new Promise(resolve => {
      this.pendingCalls.set(callId, resolve);
      this.port?.postMessage({ callId, action });
    });
  }

  private handleIncoming(msg: NativeMessage, hmacToken: string): void {
    if (!verifyHmac(msg, hmacToken)) { console.error('HMAC mismatch'); return; }
    const resolver = this.pendingCalls.get(msg.callId);
    if (resolver) { this.pendingCalls.delete(msg.callId); resolver(msg.result); }
  }
}
```

### 8.10 `DebuggerLifecycleManager` and Deep-Link Pairing (NEW v9.5.9)

**Lazy debugger policy:**

```typescript
// packages/browser-extension/src/content/DebuggerLifecycleManager.ts
export class DebuggerLifecycleManager {
  private attached = false;

  async withDebugger<T>(fn: () => Promise<T>): Promise<T> {
    if (this.policy === 'persistent') {
      if (!this.attached) {
        await chrome.debugger.attach({ tabId: this.tabId }, '1.3');
        this.attached = true;
      }
      return fn();
    }
    // lazy: attach → execute → detach per call
    await chrome.debugger.attach({ tabId: this.tabId }, '1.3');
    this.attached = true;
    try { return await fn(); }
    finally { await chrome.debugger.detach({ tabId: this.tabId }); this.attached = false; }
  }
}
```

Default policy is `'lazy'`. For content-script-only flows the debugger is never
attached; the yellow banner is absent entirely.

**Deep-link pairing** replaces 6-char code entry:

```typescript
// CLI: instead of displaying a code and waiting for user to open popup and type it,
// open the extension's pair.html directly in Chrome.
const deepLink = `chrome-extension://${EXTENSION_ID}/pair.html?token=${pairingToken}`;
await openUrl(deepLink);  // OS default browser handler; opens Chrome directly
// User sees pair.html and clicks Connect — one click; no typing.
```

**v9.5.9 updated user experience:**

1. `oweibo browser open https://example.com` (auto backend — no `--backend` needed)
2. If extension not paired: OS default browser opens to the extension's `pair.html`.
   User clicks Connect. Terminal: `[browser] Extension connected.`
3. **All subsequent runs:** `BrowserSessionRouter` detects extension is connected;
   selects `extension` backend automatically. No CLI flags needed.

### 8.11 Unified HITL Surface (NEW v9.5.9)

**Root cause of the old split:** v9.5.8's `ExtensionHITLBridge` put gate cards only
in the extension popup — a secondary UI requiring the user to notice a badge and
click the icon. Extension users watching the active tab saw it freeze with no
explanation.

**`HITLSurfaceCoordinator`** is the single gate lifecycle authority. Every surface
registers through it. First response wins; all others dismiss instantly.

```typescript
// packages/browser-extension/src/hitl/HITLSurfaceCoordinator.ts
export class HITLSurfaceCoordinator {
  private readonly gates = new Map<string, { gate: HITLGate; tabId: number; resolved: boolean }>();

  async open(gate: HITLGate, tabId: number): Promise<void> {
    if (this.gates.has(gate.gateId)) return;
    this.gates.set(gate.gateId, { gate, tabId, resolved: false });
    await Promise.allSettled([
      this.overlay.show(gate, tabId),
      this.notification.show(gate, tabId),
    ]);
  }

  async resolve(resolution: GateResolution): Promise<void> {
    const entry = this.gates.get(resolution.gateId);
    if (!entry || entry.resolved) return; // idempotent
    entry.resolved = true;
    this.gates.delete(resolution.gateId);
    await Promise.allSettled([
      this.overlay.dismiss(resolution.gateId, entry.tabId),
      this.notification.dismiss(resolution.gateId),
    ]);
    await this.bridge.sendAction(crypto.randomUUID(), {
      type: 'handle-dialog', accept: resolution.accept, promptText: resolution.promptText,
    });
  }
}
```

**`InTabHITLOverlay`** — injects `hitl-overlay.js` into the active tab on demand
(separate esbuild entry point; not bundled into `content-script.js`). Renders a
floating panel top-right of the page with Accept/Dismiss buttons. The panel uses
CSS `animation` for slide-in/slide-out and is scoped with `data-oweibo-hitl` to
avoid page CSS conflicts. Multiple concurrent gates stack vertically. Injection
silently skips restricted tabs (`chrome://`, `file://`).

**`DesktopNotificationFallback`** — checks `chrome.windows.get(tab.windowId).focused`
before firing. Only activates when the tab is genuinely backgrounded. OS notification
buttons (Accept/Dismiss) resolve the gate directly without requiring the user to
switch to the browser first. Clicking the notification body focuses the tab so the
overlay becomes visible.

**Complete gate flow:**

```
1. BrowserEventStreamer emits 'browser-dialog-pending'
2. ExtensionHITLBridge → coordinator.open(gate, tabId)
3. HITLSurfaceCoordinator fans out:
   ├── InTabHITLOverlay.show()  → hitl-overlay.js injected → floating panel in tab
   └── DesktopNotificationFallback.show()
         → tab active? skip (overlay sufficient)
         → tab backgrounded? OS notification fired
   ExtensionHITLBridge also:
   ├── bridge.sendToPopup({ type: 'hitl-gate', gate })  [popup unchanged]
   └── updateBadge()                                     [badge unchanged]

4. User responds on ANY surface:
   ├─ In-tab Accept → content script → 'hitl-overlay-resolve' → coordinator.resolve({ resolvedBy: 'overlay' })
   ├─ OS notification button → coordinator.resolve({ resolvedBy: 'notification' })
   └─ Popup Accept → ExtensionHITLBridge.resolveGate() → coordinator.resolve({ resolvedBy: 'popup' })

5. coordinator.resolve() (first call wins; subsequent are no-ops):
   ├── overlay.dismiss()       → card animates out
   ├── notification.dismiss()  → OS notification cleared
   ├── sendToPopup(hitl-dismiss) → popup card removed
   ├── updateBadge()
   └── bridge.sendAction(handle-dialog) → BrowserSessionManager gets the answer

6. Terminal receives resolution via TaskEventBus (unchanged).
```

**Updated extension popup** — shows gate card when a gate is pending; shows standard
session status view otherwise. Renders multiple stacked cards for concurrent gates.
Badge count reflects `coordinator.pendingCount()`.

---

## 9. BrowserEventStreamer

All 44 events from v9.5.8 are unchanged. v9.5.9 adds 2 (total: **46**):

```
browser-backend-auto-selected  ← BrowserSessionRouter selected a backend; { selected, tenantId, sessionId }
browser-cookies-imported       ← import-cookies completed; { domain, cookieCount, tenantId, taskId }
```

---

## 10. Integration with Existing Architecture (unchanged from v9.5.8)

`ToolRegistry` registration, `BrowserPromptBudget` collaborator wiring,
`DeliveryConfig` extension, `GeneralAssistOrchestrator` session lifecycle,
`CognitiveEngine` startup wiring, `WarmPool` sandbox routing, and multi-tenant
isolation invariants are all unchanged.

---

## 11. CLI Extension — `oweibo browser` Commands

All 38 commands from v9.5.8 are unchanged. v9.5.9 changes:

- **`auto` is now the default backend** — `oweibo browser open <url>` selects backend automatically.
- **Deep-link pairing** replaces code-entry flow for first-time extension pairing.
- **`oweibo browser import-cookies <domain>`** — new shorthand for the `import-cookies` action.
- **`oweibo browser autofill`** — new shorthand for the `autofill-credentials` action.

---

## 12. Security Hardening

### 12.1–12.13 (unchanged from v9.5.8)

`BrowserContentPolicy`, download/upload sandbox, egress proxy, `eval` audit trail,
dialog policy, network intercept gate, video/HAR SHA-256, PDF sandbox, DLP filter,
screenshot watermarking, extension allowlist, browser extension banner explanation,
`UserChromeBackend` audit — all unchanged.

### 12.14 Content Script Security (NEW v9.5.9)

Content scripts run in the page's document context. The `chrome.runtime.onMessage`
channel is restricted to messages from the extension's own background script origin —
external pages cannot inject messages. The content script accesses no `chrome.*` APIs,
performs no network requests, and reads no cookies. Its attack surface is DOM
manipulation on the injected page only.

### 12.15 `import-cookies` Security (NEW v9.5.9)

Cookie values flow only through the HMAC-authenticated native messaging pipe and
are applied to the session context. They are never written to Redis session state,
never appear in `BrowserActionResult.observation` or `data` fields, and pass through
`BrowserDlpFilter` with values masked. Audit entry records domain and count only.
Trust gate: `allowCookieImport`. Extension popup shows a one-time consent banner
per domain.

### 12.16 `autofill-credentials` Security (NEW v9.5.9)

The content script triggers Chrome's native autofill. `HTMLInputElement.value`
returns an empty string for `type="password"` inputs filled by autofill — Chrome
security constraint. Oweibo never has access to the filled credential values.
Audit entry records target hostname only.

### 12.17 Native Messaging Security (NEW v9.5.9)

The native messaging channel is restricted to the extension's `chrome-extension://`
origin by the host manifest. Only the Oweibo extension can send messages to the
native host. Messages are HMAC-authenticated identically to the WebSocket scheme.
No socket exists that a rogue process could enumerate or connect to.

### 12.18 Lazy Debugger Transparency (NEW v9.5.9)

`extensionDebuggerPolicy: 'lazy'` means the yellow debugger banner appears briefly
around each page-level CDP action and disappears immediately after. This is more
visible than the persistent-but-ignorable banner from v9.5.8 — users can see exactly
when elevated browser access is invoked. It is a security transparency improvement,
not a weakening.

### 12.19 Updated Trust Gate Reference

```
Gate                  Action                    Default
──────────────────────────────────────────────────────────────────────
allowCookieImport     import-cookies            false supervised / true autonomous  ← NEW v9.5.9
allowAutofill         autofill-credentials      true all modes                      ← NEW v9.5.9
allowExtensionBridge  extension backend          true all modes
allowUserChrome       userchrome backend         false all modes
allowPersistentProfile persistent backend        false all modes
allowBrowserEval      eval                       false supervised
allowRawMouse         mouse-move/down/up         true all modes
allowNetworkIntercept intercept-request          false supervised
allowVideoRecord      record-video-*             true all modes
allowHarCapture       har-start                  true all modes
allowPermissionMock   grant-permissions          false supervised
allowExtensionLoad    load-extension             false all modes
allowHeadful          headful flag               false all modes
allowSessionShare     share-session              true all modes
allowBrowserPaymentAutomation  checkout flows    false supervised
```

---

## 13. Dependency Graph and Cruiser Rules (unchanged from v9.5.8)

All 6 existing dependency-cruiser rules are unchanged. The v9.5.9 additions
(`ContentScriptActionEngine`, `NativeMessagingBridge`, `HITLSurfaceCoordinator`,
`InTabHITLOverlay`, `DesktopNotificationFallback`) all live within
`browser-extension/` and import only from `core-contracts` and the extension's
own internal modules — no new cross-package dependency edges are introduced.

---

## 14. Configuration and Vault Paths

### `BrowserToolConfig` additions (v9.5.9)

```typescript
extensionBridgeMode: 'native' | 'websocket';   // default 'native'
defaultBackend: 'auto' | BackendCandidate;      // default 'auto'
```

### Vault Path Reference (complete — v9.5.9)

All paths from v9.5.8 are unchanged. v9.5.9 additions:

| Secret / Config | Vault Path |
|---|---|
| Allow cookie import | `oweibo/tenants/{tenantId}/browser/allow-cookie-import` *(default true autonomous / false supervised)* |
| Allow autofill | `oweibo/tenants/{tenantId}/browser/allow-autofill` *(default true all modes)* |
| Extension bridge mode | `oweibo/tenants/{tenantId}/browser/extension-bridge-mode` (`'native'` \| `'websocket'`, default `'native'`) |
| Default backend | `oweibo/tenants/{tenantId}/browser/default-backend` (`'auto'` \| any explicit backend, default `'auto'`) |
| Extension debugger policy | `oweibo/tenants/{tenantId}/browser/extension-debugger-policy` (`'lazy'` \| `'persistent'`, default `'lazy'`) |

---

## 15. Surgical Edits to Existing Files

All edits from v9.5–v9.5.8 are preserved verbatim. v9.5.9 adds:

| File | Change | Version |
|---|---|---|
| `packages/core-contracts/src/browser.ts` | ADD: `'import-cookies'`, `'autofill-credentials'`, `'extension-hitl-respond'` to `BrowserActionType`; corresponding variants to `BrowserAction` union; `'auto'` to `BrowserSessionConfig.backend`; `extensionDebuggerPolicy?`, `extensionBridgeMode?` on `BrowserSessionConfig`; `allowCookieImport`, `allowAutofill` on `ISecurityContext`; `HITLGate` type | **v9.5.9** |
| `packages/core-contracts/src/agent.ts` | ADD: `'browser-backend-auto-selected'`, `'browser-cookies-imported'` to `TaskEventType` union | **v9.5.9** |
| `packages/browser-tool/src/tool/BrowserActionSchema.ts` | ADD: Zod schemas for 3 new action variants | **v9.5.9** |
| `packages/browser-tool/src/session/BrowserSessionManager.ts` | ADD: `BrowserSessionRouter` delegation when `backend === 'auto'`; `hitlBridge.clearGates(sessionId)` in `destroySession` for extension sessions | **v9.5.9** |
| `packages/browser-tool/src/stealth/BrowserBackendRouter.ts` | ADD: `'auto'` handled by delegating to `BrowserSessionRouter` before existing chain | **v9.5.9** |
| `packages/browser-extension/src/bridge/ExtensionHITLBridge.ts` | REWRITE: delegate gate registration/resolution to `HITLSurfaceCoordinator`; remove internal `this.pending`; popup and badge paths unchanged | **v9.5.9** |
| `packages/browser-extension/src/background.ts` | ADD: `HITLSurfaceCoordinator`, `InTabHITLOverlay`, `DesktopNotificationFallback`, `NativeMessagingBridge` construction and wiring; `hitl-overlay-resolve` message listener | **v9.5.9** |
| `packages/browser-extension/manifest.json` | ADD: `"scripting"`, `"cookies"`, `"nativeMessaging"`, `"notifications"` permissions; `content_scripts` entry for `content-script.js`; `host_permissions: ["<all_urls>"]` | **v9.5.9** |
| `packages/browser-extension/esbuild.config.js` | ADD: `hitl-overlay.ts` as separate entry point | **v9.5.9** |
| `packages/cli/src/renderer/TaskEventRenderer.ts` | ADD: render cases for `browser-backend-auto-selected`, `browser-cookies-imported` | **v9.5.9** |
| `packages/cli/src/commands/index.ts` | ADD: `import-cookies`, `autofill` CLI shorthands; `auto` as default `--backend`; deep-link pairing flow | **v9.5.9** |

---

## 16. Testing Strategy

### 16.1 Unit Tests (additions for v9.5.9)

| Test | Description |
|---|---|
| `ContentScriptActionEngine — click produces isTrusted event` | Mock `chrome.tabs.sendMessage`. Assert content script invoked; response `success: true`. |
| `ContentScriptActionEngine — screenshot falls through to debugger` | Assert `ContentScriptActionEngine.dispatch` NOT called; `DebuggerLifecycleManager.withDebugger` IS called. |
| `DebuggerLifecycleManager — lazy: attach and detach per call` | `policy: 'lazy'`. Call `withDebugger` twice. Assert `attach` called twice, `detach` called twice. |
| `DebuggerLifecycleManager — persistent: attach once` | `policy: 'persistent'`. Call `withDebugger` twice. Assert `attach` called once, `detach` never. |
| `NativeMessagingBridge — HMAC mismatch ignored` | Wrong HMAC. Assert resolver not called; error logged. |
| `NativeMessagingBridge — call resolved on response` | Send action; port returns matching callId. Assert promise resolves. |
| `BrowserSessionRouter — cloud-required domain` | `getTier` returns `cloud-required`. Assert `selectBackend` returns `browserbase`. |
| `BrowserSessionRouter — extension connected wins` | `extensionConnected: true`. Assert `extension` returned. |
| `BrowserSessionRouter — persistent for auth task` | `taskHint: 'auth', persistentProfileExists: true`. Assert `persistent` returned. |
| `ImportCookiesAction — no cookies` | `chrome.cookies.getAll` returns `[]`. Assert `NO_COOKIES_FOUND`. |
| `ImportCookiesAction — audit log has no values` | Mock sensitive cookies. Assert audit entry has only `domain` and `cookieCount`. |
| `ImportCookiesAction — blocked in supervised` | `allowCookieImport: false`. Assert `BrowserPolicyViolationError`. |
| `AutofillCredentialsAction — AUTOFILL_DID_NOT_TRIGGER` | Field empty after 800ms. Assert error result with fallback suggestion. |
| `HITLSurfaceCoordinator — idempotent resolve` | Resolve same gateId twice. Assert `bridge.sendAction` called once. |
| `HITLSurfaceCoordinator — overlay + notification dismissed on resolve` | Resolve gate. Assert `overlay.dismiss()` and `notification.dismiss()` both called. |
| `ExtensionHITLBridge — badge updates on gate` | Emit `browser-dialog-pending`. Assert badge text `'1'`. |
| `ExtensionHITLBridge — badge clears on resolve` | Emit pending, resolve. Assert badge text `''`. |
| `DesktopNotificationFallback — skipped when tab active` | Tab active + window focused. Assert `chrome.notifications.create` NOT called. |
| `DesktopNotificationFallback — fires when tab backgrounded` | Tab not active. Assert `chrome.notifications.create` called. |
| `DesktopNotificationFallback — button click resolves gate` | Click button 0 (Accept). Assert `coordinator.resolve({ accept: true })` called. |
| `InTabHITLOverlay — show sends message to content script` | `overlay.show(gate, tabId)`. Assert `chrome.scripting.executeScript` called; `chrome.tabs.sendMessage` sent with `{ cmd: 'show', gate }`. |
| `InTabHITLOverlay — dismiss sends message` | `overlay.dismiss(gateId, tabId)`. Assert `chrome.tabs.sendMessage` sent with `{ cmd: 'dismiss', gateId }`. |
| `deep-link pairing — URL format` | Assert `chrome-extension://[id]/pair.html?token=…` format. |
| `auto backend — emits selection event` | `backend: 'auto'`. Assert `browser-backend-auto-selected` emitted with `selected` field. |

### 16.2 Integration Tests (additions for v9.5.9)

| Test | Description |
|---|---|
| `content script — real click isTrusted` | Load test page logging `event.isTrusted`. Assert `true` logged. |
| `content script — real type event sequence` | Load form. Type via content script. Assert `input` and `change` events fired with `isTrusted: true`. |
| `lazy debugger — banner absent during content-script-only flow` | Run click+type+scroll. Assert `chrome.debugger.attach` never called. |
| `lazy debugger — brief during screenshot` | Run `screenshot`. Assert `attach` then `detach` within 500ms. |
| `native messaging — round trip` | Register native host. Send action. Assert response within 500ms. |
| `import-cookies — LinkedIn bootstrap` | User logged into LinkedIn. `import-cookies domain:linkedin.com`. Navigate to feed. Assert authenticated. |
| `autofill-credentials — form fill` | Load login form in headful Chrome. Save credentials. `autofill-credentials`. Assert form filled. |
| `auto backend — extension wins if paired` | Pair extension. `backend: auto`. Assert session uses extension backend. |
| `HITL bridge — in-tab overlay renders gate` | Emit `browser-dialog-pending`. Assert floating panel injected into tab DOM. |
| `HITL bridge — resolve from overlay closes all surfaces` | Click Accept in overlay. Assert popup card removed, notification cleared, badge count 0. |
| `HITL bridge — resolve from notification closes all surfaces` | Click OS notification button. Assert overlay dismissed, popup card removed. |
| `deep-link pairing — end to end` | CLI calls `openUrl(deepLink)`. Assert Chrome opens `pair.html`; one click completes pair; terminal shows connected. |

### 16.3 Security Tests (additions for v9.5.9)

| Test | Description |
|---|---|
| `import-cookies — supervised block` | `allowCookieImport: false`. Assert `BrowserPolicyViolationError`. |
| `import-cookies — observation has no values` | Assert no cookie value strings in observation or data fields. |
| `native messaging — wrong origin rejected` | Non-extension origin cannot connect to native host (Chrome enforces; document test). |
| `content script — no chrome.* access` | Assert `typeof chrome.storage === 'undefined'` inside content-script.js. |
| `autofill — password not readable` | After autofill, assert `document.querySelector('input[type=password]').value === ''`. |

### 16.4–16.5 (unchanged from v9.5.8)

All multi-tenant isolation tests, security tests, and end-to-end tests from v9.5.8
are unchanged.

---

## 17. Rollout Plan

### Phases 1–12 (Weeks 1–12) — unchanged from v9.5.8

All 12 phases are preserved verbatim.

### Phase 13 — Manus Gap Closure + Unified HITL (Weeks 13–14)

**Priority order:** content script engine → lazy debugger → native messaging →
import-cookies → autofill-credentials → `BrowserSessionRouter` → HITL bridge →
deep-link pairing → in-tab overlay → desktop notification → coordinator wiring.

**Week 13:**
- [ ] `content-script.ts` — full implementation of all 38 DOM-tier action handlers
- [ ] `ContentScriptActionEngine.ts` — background-to-content dispatch
- [ ] `ChromeExtensionBackend` routing — DOM actions → content script, page-level → debugger
- [ ] `DebuggerLifecycleManager.ts` — lazy policy; `'lazy'` as default
- [ ] `extensionDebuggerPolicy` field on `BrowserSessionConfig`
- [ ] `manifest.json` — add `scripting`, `cookies`, `nativeMessaging`, `notifications`, `content_scripts`, `host_permissions`
- [ ] Unit + integration tests: content script actions, debugger lifecycle, `isTrusted: true` validation (headful Chrome)

**Week 14:**
- [ ] `NativeMessagingBridge.ts` + `oweibo-native-host` binary + manifest install script
- [ ] `ExtensionBridgeServer` annotated `@deprecated`; `extensionBridgeMode` config
- [ ] Deep-link pairing — `pair.html` in extension + CLI `openUrl()` call
- [ ] `ImportCookiesAction.ts` + `allowCookieImport` trust gate + audit event + DLP filter integration
- [ ] `AutofillCredentialsAction.ts` + `allowAutofill` trust gate
- [ ] `BrowserSessionRouter.ts` + `auto` backend type + `browser-backend-auto-selected` event
- [ ] `HITLSurfaceCoordinator.ts` + `InTabHITLOverlay.ts` + `DesktopNotificationFallback.ts`
- [ ] `hitl-overlay.ts` content script (separate esbuild entry point)
- [ ] `ExtensionHITLBridge.ts` rewritten to delegate to coordinator
- [ ] `background.ts` wired with coordinator + overlay resolution listener
- [ ] All security tests for new trust gates, cookie import, content script isolation
- [ ] UX test: time-from-cold-open-to-first-authenticated-action ≤ 30s for a non-technical user
- [ ] "Zero to authenticated" guide for solo users

**Total actions after Phase 13: 54.**

---

## 18. Capability Comparison (Post v9.5.9)

| Feature | Manus AI | Hermes Agent | Oweibo v9.5.8 | Oweibo v9.5.9 |
|---|---|---|---|---|
| Full interactive browser control | ✅ | ✅ | ✅ 51 actions | ✅ **54 actions** |
| Form filling & multi-step workflows | ✅ | ✅ | ✅ | ✅ |
| Real Chrome/Chromium engine | ✅ | ✅ | ✅ | ✅ |
| Persistent sessions | ✅ | ✅ | ✅ | ✅ |
| Multi-tab / multi-window | ✅ | ✅ | ✅ | ✅ |
| Vision + screenshot reasoning | ✅ | ✅ | ✅ | ✅ |
| Structured data extraction | ✅ | ✅ | ✅ | ✅ |
| File upload / download | ✅ | ✅ | ✅ | ✅ |
| Download-then-re-upload | ❌ | ❌ | ✅ | ✅ Oweibo advantage |
| JavaScript execution | ✅ | ✅ | ✅ | ✅ trust-mode gated |
| CAPTCHA / anti-bot | ✅ | ✅ | ✅ | ✅ |
| Stealth / fingerprint evasion | ✅ | ✅ | ✅ | ✅ |
| Cloud browser option | ✅ | ✅ | ✅ | ✅ |
| **DOM actions via content script (isTrusted: true)** | ✅ | ❌ | ❌ CDP only | ✅ 38/54 actions — **Oweibo advantage** |
| **chrome.debugger held only when needed** | ✅ (anecdotal) | ❌ | ❌ persistent | ✅ `'lazy'` policy default |
| **No localhost WebSocket server** | ✅ | ❌ | ❌ port 7731 | ✅ `NativeMessagingBridge` — **Oweibo advantage** |
| **One-click pairing (no code entry)** | ✅ | ❌ | ❌ 6-char code | ✅ deep-link — one click |
| **Import real Chrome cookies, zero setup** | ✅ (implicit) | ❌ | ❌ | ✅ `import-cookies` — explicit, audited — **Oweibo advantage** |
| **Chrome password manager autofill** | ✅ (inherits session) | ❌ | ❌ | ✅ `autofill-credentials` — agent never sees values — **Oweibo advantage** |
| **Automatic backend selection** | ✅ (no concept of backends) | ❌ | ❌ explicit `--backend` | ✅ `BrowserSessionRouter` + `auto` default |
| **HITL approval in browser tab** | ✅ | ❌ | ❌ terminal only | ✅ `InTabHITLOverlay` — floating panel in active tab |
| **HITL OS desktop notification** | ✅ | ❌ | ❌ | ✅ `DesktopNotificationFallback` — backgrounded tab — **Oweibo advantage** |
| **HITL multi-surface coordination** | ❌ | ❌ | ❌ | ✅ `HITLSurfaceCoordinator` — first-response-wins — **Oweibo advantage** |
| **Cookie import audit trail** | ❌ | ❌ | ❌ | ✅ domain + count; no values — **Oweibo advantage** |
| **Graduated auth ladder (4 tiers)** | ❌ single strategy | ❌ | ❌ | ✅ import-cookies → autofill → inject → HITL — **Oweibo advantage** |
| Cloud fallback auto-reset | ❌ | ❌ | ✅ | ✅ |
| Worker-restart session resilience | ❌ | ❌ | ✅ | ✅ |
| Vision loop history summarisation | ❌ | ❌ | ✅ | ✅ |
| Vision cost gate per task | ❌ | ❌ | ✅ | ✅ |
| Session concurrency limits | ❌ | ❌ | ✅ | ✅ |
| Idle session cleanup | ❌ | ❌ | ✅ | ✅ |
| Sandbox / security isolation | ✅ | ✅ | ✅++ | ✅++ |
| ClamAV with auto-refresh | ❌ | ❌ | ✅ | ✅ |
| Multi-tenant isolation | ❌ | ❌ | ✅ | ✅ |
| Audit log for sensitive actions | ❌ | ❌ | ✅ | ✅ |
| Content policy (Safe Browsing) | ❌ | ❌ | ✅ | ✅ |
| Egress proxy per tenant | ❌ | ❌ | ✅ | ✅ |
| Vault-secured credentials | ❌ | ❌ | ✅ | ✅ |
| Dialog handling + auto-policy | ✅ | ✅ | ✅ | ✅ |
| Drag & drop / offset mouse | ✅ | ✅ | ✅ | ✅ |
| Iframe / shadow DOM | ✅ | ✅ | ✅ | ✅ |
| Network request interception | ✅ | ✅ | ✅ | ✅ |
| Session video recording | ✅ | ❌ | ✅ | ✅ |
| HAR export | ✅ | ❌ | ✅ | ✅ |
| Mobile / device emulation | ✅ | ✅ | ✅ | ✅ |
| Accessibility tree extraction | ✅ | ❌ | ✅ | ✅ |
| Console + network log capture | ✅ | ✅ | ✅ | ✅ |
| DLP PII redaction | ❌ | ❌ | ✅ | ✅ |
| Screenshot audit watermarking | ❌ | ❌ | ✅ | ✅ |
| Browser as MCP server | ❌ | ❌ | ✅ | ✅ |
| Persistent profile (full user-data-dir) | ❌ | ✅ Camofox | ✅ | ✅ |
| Pre-warmed aged stealth personas | ❌ | ✅ Camofox | ✅ | ✅ |
| Auto-retirement on bot detection | ❌ | ❌ | ✅ | ✅ |
| Chrome extension (zero-setup) | ✅ Manus Browser Operator | limited | ✅ | ✅ |
| Prompt budget collaborator | ❌ | ❌ | ✅ | ✅ |
| Skill-driven browser actions | ❌ | ❌ | ✅ | ✅ |
| Desktop / file-system integration | ✅ Manus My Computer | ✅ | ❌ deferred → `DesktopTool` | ❌ deferred |

---

*End of oweibo BrowserTool Unified Implementation Plan v9.5.9*
