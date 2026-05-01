/**
 * lib/api.ts — server-side API clients.
 *
 * Use from Server Components and Route Handlers.
 * Reads the session token from cookies on every call (no singleton state).
 */
import { getSessionToken } from './auth.js';

const IDENTITY_URL = process.env['IDENTITY_URL'] ?? 'http://localhost:3110';
const PIPELINE_URL = process.env['PIPELINE_URL'] ?? 'http://localhost:3100/api/v1';

async function apiFetch<T>(
  baseUrl: string,
  path:    string,
  init?:   RequestInit & { noAuth?: boolean },
): Promise<T> {
  const token = init?.noAuth ? null : await getSessionToken();
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type':  'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
    next: { revalidate: 0 },
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    const err = Object.assign(new Error(`HTTP ${res.status} from ${path}`), { status: res.status, body });
    throw err;
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

// ── Identity service ───────────────────────────────────────────────────────

export const identityApi = {
  get:   <T>(path: string) =>
    apiFetch<T>(IDENTITY_URL, path),
  post:  <T>(path: string, body?: unknown, noAuth = false) =>
    apiFetch<T>(IDENTITY_URL, path, { method: 'POST', body: JSON.stringify(body), noAuth }),
  patch: <T>(path: string, body?: unknown) =>
    apiFetch<T>(IDENTITY_URL, path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) =>
    apiFetch<T>(IDENTITY_URL, path, { method: 'DELETE' }),
};

// ── Pipeline service ───────────────────────────────────────────────────────

export const pipelineApi = {
  get:  <T>(path: string) =>
    apiFetch<T>(PIPELINE_URL, path),
  post: <T>(path: string, body?: unknown) =>
    apiFetch<T>(PIPELINE_URL, path, { method: 'POST', body: JSON.stringify(body) }),
};
