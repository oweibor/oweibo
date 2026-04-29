/**
 * client.ts — HTTP clients for the oweibo API services.
 *
 * Two clients:
 *   api          — kilo-pipeline / core-engine  (OWEIBO_API_URL, default :3100)
 *   identityApi  — apps/identity               (OWEIBO_IDENTITY_URL, default :3110)
 *
 * Authentication precedence (per request):
 *   1. OWEIBO_API_KEY env var
 *   2. ~/.oweibo/credentials access_token (with transparent refresh on 401)
 */
import { readCredentials, writeCredentials, isTokenExpired } from './credentials.js';

export interface ClientConfig {
  readonly baseUrl:   string;
  readonly apiKey:    string;
  readonly timeoutMs: number;
}

export interface ApiError {
  status: number;
  body:   unknown;
}

function loadConfig(urlEnv: string, defaultUrl: string): ClientConfig {
  const baseUrl = process.env[urlEnv] ?? defaultUrl;
  const apiKey  = process.env['OWEIBO_API_KEY'] ?? '';
  return { baseUrl, apiKey, timeoutMs: 30_000 };
}

async function getBearerToken(identityBaseUrl: string): Promise<string> {
  // 1. Hard-coded env var takes precedence
  const envKey = process.env['OWEIBO_API_KEY'];
  if (envKey) return envKey;

  // 2. Credentials file
  const creds = readCredentials();
  if (!creds) return '';

  // 3. Transparent refresh if token is about to expire
  if (isTokenExpired(creds)) {
    try {
      const res = await fetch(`${identityBaseUrl}/api/v1/auth/refresh`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ refresh_token: creds.refresh_token }),
      });
      if (res.ok) {
        const refreshed = await res.json() as { access_token: string; expires_at: string };
        writeCredentials({ ...creds, access_token: refreshed.access_token, expires_at: refreshed.expires_at });
        return refreshed.access_token;
      }
    } catch { /* fall through — let the request fail with the expired token */ }
  }

  return creds.access_token;
}

async function request<T>(
  method:     string,
  baseUrl:    string,
  path:       string,
  body?:      unknown,
  overrides?: Partial<ClientConfig>,
): Promise<T> {
  const cfg    = { ...loadConfig('OWEIBO_API_URL', 'http://localhost:3100/api/v1'), ...overrides };
  const iUrl   = process.env['OWEIBO_IDENTITY_URL'] ?? 'http://localhost:3110';
  const token  = await getBearerToken(iUrl);
  const url    = `${baseUrl}${path}`;
  const ctrl   = new AbortController();
  const timer  = setTimeout(() => ctrl.abort(), cfg.timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type':  'application/json',
        Authorization:   token ? `Bearer ${token}` : '',
      },
      body:   body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      let errorBody: unknown;
      try { errorBody = await res.json(); } catch { errorBody = await res.text(); }
      const err = new Error(`HTTP ${res.status} ${res.statusText}`);
      (err as any).status = res.status;
      (err as any).body   = errorBody;
      throw err;
    }

    const text = await res.text();
    return text ? JSON.parse(text) as T : ({} as T);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── Pipeline / core-engine API ─────────────────────────────────────────────

const PIPELINE_URL = () =>
  process.env['OWEIBO_API_URL'] ?? 'http://localhost:3100/api/v1';

export const api = {
  get:    <T>(path: string) => request<T>('GET',    PIPELINE_URL(), path),
  post:   <T>(path: string, body?: unknown) => request<T>('POST',   PIPELINE_URL(), path, body),
  patch:  <T>(path: string, body?: unknown) => request<T>('PATCH',  PIPELINE_URL(), path, body),
  delete: <T>(path: string) => request<T>('DELETE', PIPELINE_URL(), path),
};

// ── Identity API ──────────────────────────────────────────────────────────

const IDENTITY_URL = () =>
  process.env['OWEIBO_IDENTITY_URL'] ?? 'http://localhost:3110';

export const identityApi = {
  get:    <T>(path: string) => request<T>('GET',    IDENTITY_URL(), path),
  post:   <T>(path: string, body?: unknown) => request<T>('POST',   IDENTITY_URL(), path, body),
  patch:  <T>(path: string, body?: unknown) => request<T>('PATCH',  IDENTITY_URL(), path, body),
  delete: <T>(path: string) => request<T>('DELETE', IDENTITY_URL(), path),
};

export { loadConfig };
