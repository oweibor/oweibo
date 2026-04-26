/**
 * @oweibo/core-contracts — Browser types
 *
 * All browser contract types live here. Zero Playwright imports — safe to import anywhere.
 * Re-exported from the package root index.ts.
 *
 * Versions: v9.5.3 baseline → v9.5.4 (dialogs, mouse, iframe, network, video, HAR, a11y, logs)
 *           → v9.5.5 (key-chord, geolocation, PDF, extensions, session-share, DLP, watermark)
 *           → v9.5.6 (inject-credentials, UserChrome backend, domain reputation)
 *           → v9.5.7 (persistent profiles, stealth persona pool)
 *           → v9.5.8 (ChromeExtension backend, extension bridge protocol)
 */

import type { ISecurityContext, TaskEventType } from './types/AgentTypes.js';

// ─── Action Types ─────────────────────────────────────────────────────────────

export type BrowserActionType =
  // v9.5.3 original 29 actions
  | 'navigate' | 'click' | 'type' | 'scroll' | 'hover' | 'select'
  | 'check' | 'wait' | 'wait-for-selector' | 'submit' | 'screenshot'
  | 'snapshot' | 'extract' | 'eval' | 'tab-open' | 'tab-switch'
  | 'tab-close' | 'tabs-list' | 'go-back' | 'go-forward' | 'reload'
  | 'clear-cookies' | 'get-cookies' | 'set-cookies' | 'upload' | 'download'
  | 'get-url' | 'get-title' | 'move-to-upload'
  // v9.5.4 additions — 14 new actions (total: 43)
  | 'handle-dialog'
  | 'drag-and-drop'
  | 'mouse-move'
  | 'mouse-down'
  | 'mouse-up'
  | 'switch-to-frame'
  | 'switch-to-main'
  | 'intercept-request'
  | 'mock-response'
  | 'remove-intercept'
  | 'record-video-start'
  | 'record-video-stop'
  | 'har-start'
  | 'har-stop'
  | 'emulate-device'
  | 'accessibility-snapshot'
  | 'log-capture-start'
  | 'log-capture-stop'
  // v9.5.5 additions — 7 new actions (total: 50)
  | 'key-chord'
  | 'set-geolocation'
  | 'grant-permissions'
  | 'revoke-permissions'
  | 'print-to-pdf'
  | 'load-extension'
  | 'share-session'
  // v9.5.6 additions — 1 new action (total: 51)
  | 'inject-credentials'
  // v9.5.9 additions — 3 new actions (total: 54)
  | 'import-cookies'
  | 'autofill-credentials'
  | 'extension-hitl-respond';

export type BrowserAction =
  // ── v9.5.3 actions ──────────────────────────────────────────────────────────
  | { type: 'navigate'; url: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }
  | { type: 'click'; selector: string; button?: 'left' | 'right' | 'middle'; clickCount?: number }
  | { type: 'type'; selector: string; text: string; delay?: number; clearFirst?: boolean }
  | { type: 'scroll'; selector?: string; direction: 'up' | 'down' | 'left' | 'right'; distance?: number }
  | { type: 'hover'; selector: string }
  | { type: 'select'; selector: string; value: string | string[] }
  | { type: 'check'; selector: string; checked: boolean }
  | { type: 'wait'; ms: number }
  | { type: 'wait-for-selector'; selector: string; state?: 'visible' | 'hidden' | 'attached' | 'detached'; timeout?: number }
  | { type: 'submit'; selector: string }
  | { type: 'screenshot'; fullPage?: boolean; element?: string }
  | { type: 'snapshot' }
  | { type: 'extract'; selectors: { name: string; query: string; attribute?: string }[] }
  | { type: 'eval'; expression: string }
  | { type: 'tab-open'; url?: string }
  | { type: 'tab-switch'; tabId: string }
  | { type: 'tab-close'; tabId: string }
  | { type: 'tabs-list' }
  | { type: 'go-back' }
  | { type: 'go-forward' }
  | { type: 'reload' }
  | { type: 'clear-cookies'; domain?: string }
  | { type: 'get-cookies'; domain?: string }
  | { type: 'set-cookies'; cookies: BrowserCookie[] }
  | { type: 'upload'; selector: string; filePath: string }
  | { type: 'download'; url: string; filename?: string }
  | { type: 'get-url' }
  | { type: 'get-title' }
  | { type: 'move-to-upload'; sourcePath: string; filename?: string }
  // ── v9.5.4 additions ────────────────────────────────────────────────────────
  | { type: 'handle-dialog'; accept: boolean; promptText?: string }
  | {
      type: 'drag-and-drop';
      sourceSelector: string;
      targetSelector: string;
      sourceOffset?: { x: number; y: number };
      targetOffset?: { x: number; y: number };
      steps?: number;
    }
  | { type: 'mouse-move'; x: number; y: number }
  | { type: 'mouse-down'; button?: 'left' | 'right' | 'middle' }
  | { type: 'mouse-up'; button?: 'left' | 'right' | 'middle' }
  | { type: 'switch-to-frame'; selector: string }
  | { type: 'switch-to-main' }
  | { type: 'intercept-request'; urlPattern: string; method?: string; interceptId?: string }
  | {
      type: 'mock-response';
      interceptId: string;
      status?: number;
      headers?: Record<string, string>;
      body?: string;
      bodyEncoding?: 'utf8' | 'base64';
      contentType?: string;
    }
  | { type: 'remove-intercept'; interceptId: string }
  | { type: 'record-video-start'; width?: number; height?: number }
  | { type: 'record-video-stop' }
  | { type: 'har-start'; urlFilter?: string; omitContent?: boolean }
  | { type: 'har-stop' }
  | { type: 'emulate-device'; deviceName?: string; customDescriptor?: BrowserDeviceDescriptor }
  | { type: 'accessibility-snapshot'; rootSelector?: string; maxDepth?: number }
  | { type: 'log-capture-start' }
  | { type: 'log-capture-stop' }
  // ── v9.5.5 additions ────────────────────────────────────────────────────────
  | { type: 'key-chord'; keys: string; count?: number }
  | { type: 'set-geolocation'; latitude: number; longitude: number; accuracy?: number }
  | { type: 'grant-permissions'; permissions: BrowserPermission[]; origin?: string }
  | { type: 'revoke-permissions' }
  | {
      type: 'print-to-pdf';
      filename?: string;
      format?: 'A4' | 'Letter';
      landscape?: boolean;
      printBackground?: boolean;
      margin?: { top?: string; bottom?: string; left?: string; right?: string };
    }
  | { type: 'load-extension'; extensionId: string }
  | { type: 'share-session'; ttlSeconds?: number }
  // ── v9.5.6 additions ────────────────────────────────────────────────────────
  | {
      type: 'inject-credentials';
      serviceId: string;
      submitAfterFill?: boolean;
      usernameSelector?: string;
      passwordSelector?: string;
    }
  // ── v9.5.9 additions ────────────────────────────────────────────────────────
  /**
   * Reads the user's real Chrome cookies for `domain` via the extension bridge
   * (chrome.cookies.getAll) and applies them to the active session context.
   * Extension-mode only. Requires `securityContext.allowCookieImport`.
   */
  | { type: 'import-cookies'; domain: string }
  /**
   * Triggers Chrome's native autofill popup. Oweibo never sees the filled
   * credential values — Chrome returns '' for password inputs filled by
   * autofill. Requires `securityContext.allowAutofill`.
   */
  | { type: 'autofill-credentials'; usernameSelector?: string; submitAfterFill?: boolean }
  /**
   * Internal: an extension-side HITL surface (overlay / popup / notification)
   * is reporting a user response. Routed by HITLSurfaceCoordinator into the
   * pipeline so the in-flight gate resolves.
   */
  | { type: 'extension-hitl-respond'; gateId: string; accept: boolean; promptText?: string };

// ─── Cookie ───────────────────────────────────────────────────────────────────

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

// ─── Session Config ───────────────────────────────────────────────────────────

export interface BrowserSessionConfig {
  tenantId: string;
  sessionId: string;
  taskId: string;
  /**
   * v9.5.9 — `'auto'` consults BrowserSessionRouter to pick the optimal backend
   * based on extension connection, profile availability, stealth pool, and
   * domain reputation. New CLI default.
   */
  backend: 'auto' | 'local' | 'browserbase' | 'brightdata' | 'userchrome' | 'persistent' | 'extension';
  locale?: string;
  timezoneId?: string;
  storageState?: string;
  browserbaseProjectId?: string;
  brightDataZone?: string;
  egressProxy?: { server: string; username: string; password: string };
  viewport?: { width: number; height: number };
  /** v9.5.6 — CDP URL for UserChromeBackend (e.g. 'http://localhost:9222') */
  cdpEndpoint?: string;
  /** v9.5.6 — serviceId to pre-load from BrowserCredentialStore */
  credentialRef?: string;
  /** v9.5.7 — explicit profile key; mutually exclusive with useStealthPool */
  persistentProfileId?: string;
  /** v9.5.7 — acquire a pre-warmed pool persona */
  useStealthPool?: boolean;
  /** v9.5.5 — launch browser in headed mode (debug) */
  headful?: boolean;
  /** v9.5.9 — debugger attach policy when backend === 'extension'. Default 'lazy'. */
  extensionDebuggerPolicy?: 'persistent' | 'lazy';
  /** v9.5.9 — extension transport selector. Default 'native' (NativeMessagingBridge). */
  extensionBridgeMode?: 'websocket' | 'native';
}

// ─── Page Snapshot ────────────────────────────────────────────────────────────

export interface PageSnapshot {
  url: string;
  title: string;
  links: { text: string; href: string }[];
  inputs: { name?: string; id?: string; type: string; placeholder?: string; selector: string }[];
  buttons: { text: string; selector: string }[];
  visibleText: string;
  forms: { id?: string; action?: string; method?: string; inputCount: number }[];
}

// ─── Tool + Execution Context ─────────────────────────────────────────────────

export interface IBrowserTool {
  execute(action: BrowserAction, context: IBrowserExecutionContext): Promise<BrowserActionResult>;
  destroySession(tenantId: string, sessionId: string): Promise<void>;
  listTabs(tenantId: string, sessionId: string): Promise<BrowserTabState[]>;
}

export interface IBrowserEventEmitter {
  emit(type: TaskEventType, payload: Record<string, unknown>): void;
}

export interface IBrowserExecutionContext {
  tenantId: string;
  sessionId: string;
  taskId: string;
  securityContext: ISecurityContext;
  eventEmitter: IBrowserEventEmitter;
}

export interface BrowserActionResult {
  success: boolean;
  actionType: BrowserActionType;
  observation: string;
  data?: Record<string, unknown>;
  screenshotBase64?: string;
  extracted?: string[];
  evalResult?: unknown;
  downloadResult?: BrowserDownloadResult;
  /** v9.5.3 — typed DOM snapshot from 'snapshot' action */
  snapshot?: PageSnapshot;
  /** v9.5.4 — returned by 'accessibility-snapshot' action */
  accessibilityTree?: AccessibilityNode;
  /** v9.5.4 — returned by 'log-capture-stop' action */
  logSnapshot?: BrowserLogSnapshot;
  /** v9.5.5 — returned by 'print-to-pdf' action */
  pdfResult?: BrowserPdfResult;
  error?: string;
}

// ─── Session and Tab ──────────────────────────────────────────────────────────

export interface BrowserSession {
  sessionId: string;
  tenantId: string;
  taskId: string;
  createdAt: string;
  lastActivityAt: string;
  activeTabId: string;
  backend: 'local' | 'browserbase' | 'brightdata' | 'userchrome' | 'persistent' | 'extension';
  storageStateBase64?: string;
  /** v9.5.7 — set when backend === 'persistent' */
  profileKey?: string;
  status: 'active' | 'idle' | 'migrating' | 'error' | 'closed';
}

export interface BrowserTabState {
  tabId: string;
  sessionId: string;
  tenantId: string;
  url: string;
  title: string;
  isActive: boolean;
  _pageRef?: unknown;
}

// ─── Vision ───────────────────────────────────────────────────────────────────

export interface BrowserVisionResult {
  screenshotBase64: string;
  interpretation: string;
  taskComplete: boolean;
  suggestedNextAction?: BrowserAction;
  confidence: number;
}

// ─── Download ─────────────────────────────────────────────────────────────────

export interface BrowserDownloadResult {
  sandboxPath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

// ─── Prompt Budget Collaborator ───────────────────────────────────────────────

export interface ITokenizer {
  countTokens(text: string): number;
}

export interface IPromptBudgetCollaborator {
  readonly sectionKey: string;
  trim(
    sectionText: string,
    tokenBudget: number,
    tokenizer: ITokenizer,
  ): Promise<{ trimmed: string; tokensUsed: number }>;
}

// ─── Warm Pool ────────────────────────────────────────────────────────────────

export interface IWarmPool {
  listActiveContainers(): Promise<IWarmContainer[]>;
  acquireForBrowser(tenantId: string): Promise<IWarmContainer>;
}

export interface IWarmContainer {
  readonly id: string;
  exec(command: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  setLabel(key: string, value: string): Promise<void>;
  getLabel(key: string): string | undefined;
}

// ─── Dialog Types (v9.5.4) ────────────────────────────────────────────────────

export type BrowserDialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload';
export type BrowserDialogPolicy = 'accept' | 'dismiss';

export interface BrowserDialogEvent {
  type: BrowserDialogType;
  message: string;
  defaultValue?: string;
  sessionId: string;
  tenantId: string;
  taskId: string;
}

export interface PendingDialog {
  dialogId: string;
  event: BrowserDialogEvent;
  resolve: (answer: DialogAnswer) => void;
}

export interface DialogAnswer {
  accept: boolean;
  promptText?: string;
}

// ─── Network Interception Types (v9.5.4) ──────────────────────────────────────

export type BrowserRequestStage = 'request' | 'response';

export interface BrowserInterceptRule {
  interceptId: string;
  urlPattern: string;
  method?: string;
  stage: BrowserRequestStage;
}

export interface BrowserMockResponse {
  interceptId: string;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  bodyEncoding?: 'utf8' | 'base64';
  contentType?: string;
}

export interface BrowserInterceptedRequest {
  interceptId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
}

// ─── Video and HAR Types (v9.5.4) ─────────────────────────────────────────────

export interface BrowserVideoResult {
  sandboxPath: string;
  filename: string;
  durationSeconds: number;
  sizeBytes: number;
  sha256: string;
}

export interface BrowserHarResult {
  sandboxPath: string;
  filename: string;
  entryCount: number;
  sizeBytes: number;
  sha256: string;
}

// ─── Device Emulation (v9.5.4) ────────────────────────────────────────────────

export interface BrowserDeviceDescriptor {
  name: string;
  userAgent: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
}

// ─── Accessibility (v9.5.4) ───────────────────────────────────────────────────

export interface AccessibilityNode {
  role: string;
  name?: string;
  value?: string;
  description?: string;
  checked?: boolean | 'mixed';
  pressed?: boolean | 'mixed';
  level?: number;
  disabled?: boolean;
  expanded?: boolean;
  focused?: boolean;
  children?: AccessibilityNode[];
}

// ─── Log Capture (v9.5.4) ─────────────────────────────────────────────────────

export type BrowserLogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface BrowserConsoleEntry {
  level: BrowserLogLevel;
  text: string;
  timestamp: number;
  url?: string;
  lineNumber?: number;
}

export interface BrowserNetworkEntry {
  url: string;
  method: string;
  status?: number;
  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBodySnippet?: string;
  responseBodySnippet?: string;
  durationMs?: number;
  timestamp: number;
}

export interface BrowserLogSnapshot {
  consoleLogs: BrowserConsoleEntry[];
  networkLog: BrowserNetworkEntry[];
  capturedSince: number;
  capturedUntil: number;
}

// ─── Geolocation & Permissions (v9.5.5) ──────────────────────────────────────

export type BrowserPermission =
  | 'geolocation'
  | 'notifications'
  | 'camera'
  | 'microphone'
  | 'clipboard-read'
  | 'clipboard-write'
  | 'accelerometer'
  | 'ambient-light-sensor'
  | 'background-sync'
  | 'magnetometer'
  | 'midi';

// ─── PDF (v9.5.5) ─────────────────────────────────────────────────────────────

export interface BrowserPdfResult {
  sandboxPath: string;
  filename: string;
  pageCount: number;
  sizeBytes: number;
  sha256: string;
}

// ─── Extension Loading (v9.5.5) ───────────────────────────────────────────────

export interface BrowserExtensionDescriptor {
  extensionId: string;
  name: string;
  version: string;
  serverPath: string;
}

// ─── Session Sharing (v9.5.5) ─────────────────────────────────────────────────

export interface BrowserSessionShareToken {
  tenantId: string;
  sessionId: string;
  iat: number;
  exp: number;
}

// ─── DLP (v9.5.5) ─────────────────────────────────────────────────────────────

export type DlpCategory = 'email' | 'phone' | 'ssn' | 'credit-card' | 'iban';

export interface DlpMatch {
  category: DlpCategory;
  offset: number;
  length: number;
}

// ─── Screenshot Watermark (v9.5.5) ────────────────────────────────────────────

export interface ScreenshotWatermarkMetadata {
  v: '1';
  payload: string;
  signature: string;
}

// ─── Credentials (v9.5.6) ─────────────────────────────────────────────────────

/**
 * INVARIANT: username and password NEVER appear in BrowserActionResult.observation,
 * BrowserActionResult.data, any TaskEvent payload, any audit log entry, or DLP filter input.
 * Credentials are pre-scrubbed at BrowserCredentialStore.fetch() — not post-redacted.
 */
export interface BrowserCredential {
  serviceId: string;
  username: string;
  password: string;
  totpSecret?: string;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
}

export interface EncryptedCredential {
  iv: string;
  tag: string;
  ciphertext: string;
}

// ─── Domain Reputation (v9.5.6) ───────────────────────────────────────────────

export type DomainReputationTier =
  | 'standard'
  | 'cloud-preferred'
  | 'cloud-required';

export interface DomainReputation {
  domain: string;
  tier: DomainReputationTier;
  reason?: string;
}

// ─── Profile Store (v9.5.7) ───────────────────────────────────────────────────

export interface IProfileStore {
  restore(profileKey: string, targetDir: string): Promise<boolean>;
  snapshot(profileKey: string, sourceDir: string): Promise<{ sizeBytes: number }>;
  delete(profileKey: string): Promise<void>;
  exists(profileKey: string): Promise<boolean>;
}

// ─── Stealth Persona Pool (v9.5.7) ────────────────────────────────────────────

export interface StealthPersona {
  personaId: string;
  userAgent: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  locale: string;
  timezoneId: string;
  platform: 'windows' | 'macos' | 'linux';
  chromiumVersion: string;
  searchQueries: string[];
}

export interface StealthPoolEntry {
  profileId: string;
  personaId: string;
  profileKey: string;
  status: 'available' | 'in-use' | 'warming' | 'retired';
  useCount: number;
  maxUseCount: number;
  lastUsedAt: string;
  createdAt: string;
}

// ─── HITL Gate (v9.5.9) ───────────────────────────────────────────────────────

/**
 * HITLGate — issued by HITLSurfaceCoordinator when a gate is opened.
 * Fans out simultaneously to terminal, extension popup, in-tab overlay,
 * and OS desktop notification. Canonical definition (single source of truth).
 * The browser-extension package keeps a local mirror in shared/actions.ts for
 * bundle isolation; keep them in sync.
 */
export interface HITLGate {
  gateId: string;
  type: 'dialog' | 'vision-loop';
  message: string;
  dialogType?: BrowserDialogType;
}

// ─── Extension Bridge Protocol (v9.5.8) ───────────────────────────────────────

/** Sent from ChromeExtensionBackend to the extension service worker over WebSocket. */
export interface ExtensionBridgeCommand {
  id: string;
  action: BrowserAction;
  tabId?: number;
}

/** Sent from the extension service worker back to ChromeExtensionBackend. */
export interface ExtensionBridgeResult {
  id: string;
  result?: BrowserActionResult;
  error?: string;
}

/** Pairing handshake payload — exchanged once on first connection. */
export interface ExtensionPairingPayload {
  pairingCode: string;
  hmac: string;
  agentVersion: string;
  sessionId: string;
  tenantId: string;
  tabId: number;
}

// ─── Extended ISecurityContext for Browser (v9.5.4+) ─────────────────────────

/**
 * IBrowserSecurityContext — extends ISecurityContext with browser-specific permission gates.
 * Passed to BrowserTool.execute() via IBrowserExecutionContext.
 */
export interface IBrowserSecurityContext extends ISecurityContext {
  // v9.5.4
  allowRawMouse: boolean;
  allowNetworkIntercept: boolean;
  allowVideoRecord: boolean;
  allowHarCapture: boolean;
  // v9.5.5
  allowGeolocationMock: boolean;
  allowPermissionMock: boolean;
  allowExtensionLoad: boolean;
  allowHeadful: boolean;
  allowSessionShare: boolean;
  // v9.5.6
  allowUserChrome: boolean;
  allowExtensionBridge: boolean;
  // v9.5.7
  allowPersistentProfile: boolean;
}
