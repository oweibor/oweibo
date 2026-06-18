/**
 * NOTIFY-driven invalidation of the tenant-binding cache.
 *
 * Pairs with migration 20260519_000019: AFTER triggers on tenant_memberships
 * and api_keys emit `pg_notify('oweibo_tenant_binding_changed', payload)` on
 * every commit-time change. This module owns a persistent pg Client that
 * LISTENs on that channel and evicts the matching cache entry the moment a
 * notification arrives — collapsing the worst-case revocation propagation
 * from 60 s (TTL alone) to sub-second.
 *
 * Operational notes
 * ─────────────────
 * - LISTEN requires a dedicated, long-lived session. PgBouncer in
 *   transaction-pool mode breaks this — pass the DIRECT_DATABASE_URL
 *   (bypassing PgBouncer) if you have one; the listener falls back to
 *   DATABASE_URL otherwise.
 * - On any disconnect / error we reconnect with exponential backoff and
 *   clear the full cache on successful reconnect. The cache then refills
 *   on demand. During the disconnect window the cache falls back to its
 *   60 s TTL, so revocations still propagate — just at the slower rate.
 * - The listener is best-effort. If the application never calls
 *   `startTenantBindingInvalidationListener()`, withTenantContext still
 *   enforces bindings via the per-request DB check + 60 s TTL.
 * - Safe to call from a single Node process. If you have multiple processes
 *   on one host, each maintains its own listener and its own cache.
 */
import { Client, type Notification } from 'pg';
import { _invalidateTenantBinding, _clearTenantBindingCache } from './withTenantContext.js';

const CHANNEL = 'oweibo_tenant_binding_changed';
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS  = 30_000;

interface NotificationPayload {
  kind:     'user' | 'api_key';
  subject:  string;
  tenantId: string;
  op:       string;
}

export interface TenantBindingListener {
  /** Returns once the listener has cleanly disconnected. */
  stop(): Promise<void>;
  /**
   * Resolves the first time the LISTEN session is successfully established.
   * After that, stays resolved for the lifetime of the listener — reconnects
   * do not re-pend it. Primarily useful for tests that need to be sure the
   * listener is wired up before triggering a NOTIFY.
   */
  ready: Promise<void>;
}

/**
 * Start the listener. Returns immediately; the LISTEN connection establishes
 * asynchronously in the background. If the connect fails, retries with
 * backoff — call site does not need to handle the error.
 *
 * @param connectionString  Optional override. Defaults to env
 *                          DIRECT_DATABASE_URL, then DATABASE_URL.
 */
export function startTenantBindingInvalidationListener(
  connectionString?: string,
): TenantBindingListener {
  const url = connectionString
    ?? process.env['DIRECT_DATABASE_URL']
    ?? process.env['DATABASE_URL'];
  if (!url) {
    throw new Error(
      'startTenantBindingInvalidationListener: no connection string '
      + '(set DIRECT_DATABASE_URL or DATABASE_URL, or pass one in)',
    );
  }

  let resolveReady: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });

  const state: ListenerState = {
    url,
    stopRequested:    false,
    activeClient:     null,
    reconnectAttempt: 0,
    reconnectTimer:   null,
    onReady:          () => {
      if (resolveReady) { resolveReady(); resolveReady = null; }
    },
  };

  void connect(state);

  return {
    ready,
    stop: async () => {
      state.stopRequested = true;
      if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
      }
      const c = state.activeClient;
      state.activeClient = null;
      if (c) {
        c.removeAllListeners();
        await c.end().catch(() => {});
      }
    },
  };
}

interface ListenerState {
  url:              string;
  stopRequested:    boolean;
  activeClient:     Client | null;
  reconnectAttempt: number;
  reconnectTimer:   ReturnType<typeof setTimeout> | null;
  onReady:          () => void;
}

async function connect(state: ListenerState): Promise<void> {
  if (state.stopRequested) return;

  const client = new Client({ connectionString: state.url });
  try {
    await client.connect();
    client.on('notification', handleNotification);
    client.on('error',  () => scheduleReconnect(state));
    client.on('end',    () => scheduleReconnect(state));
    await client.query(`LISTEN ${CHANNEL}`);
    state.activeClient     = client;
    state.reconnectAttempt = 0;
    // Conservatively clear cache on every (re)connect — we may have missed
    // notifications during the gap between disconnect and re-LISTEN.
    _clearTenantBindingCache();
    state.onReady();
  } catch (err) {
    console.warn(`[tenantBindingListener] connect failed: ${String(err)}`);
    await client.end().catch(() => {});
    scheduleReconnect(state);
  }
}

function scheduleReconnect(state: ListenerState): void {
  if (state.stopRequested) return;
  if (state.reconnectTimer) return;  // already scheduled
  if (state.activeClient) {
    state.activeClient.removeAllListeners();
    state.activeClient = null;
  }
  const delay = Math.min(
    RECONNECT_BASE_MS * (2 ** state.reconnectAttempt),
    RECONNECT_MAX_MS,
  );
  state.reconnectAttempt++;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void connect(state);
  }, delay);
  // Don't keep the event loop alive solely on the reconnect timer.
  state.reconnectTimer.unref?.();
}

function handleNotification(msg: Notification): void {
  if (msg.channel !== CHANNEL || !msg.payload) return;
  let parsed: NotificationPayload;
  try {
    parsed = JSON.parse(msg.payload) as NotificationPayload;
  } catch {
    return;  // malformed payload; ignore
  }
  if (
    (parsed.kind === 'user' || parsed.kind === 'api_key') &&
    typeof parsed.subject === 'string' &&
    typeof parsed.tenantId === 'string'
  ) {
    _invalidateTenantBinding(parsed.kind, parsed.subject, parsed.tenantId);
  }
}
