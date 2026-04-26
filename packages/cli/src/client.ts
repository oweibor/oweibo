/**
 * client.ts — HTTP client for the oweibo core-engine API.
 *
 * Reads API_URL and API_KEY from environment / config file.
 * All requests include Authorization: Bearer <token>.
 */

export interface ClientConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
}

export interface ApiError {
  status: number;
  body: unknown;
}

function loadConfig(): ClientConfig {
  const baseUrl = process.env['OWEIBO_API_URL'] ?? 'http://localhost:3100/api/v1';
  const apiKey  = process.env['OWEIBO_API_KEY'] ?? '';
  return { baseUrl, apiKey, timeoutMs: 30_000 };
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  config?: Partial<ClientConfig>,
): Promise<T> {
  const cfg = { ...loadConfig(), ...config };
  const url = `${cfg.baseUrl}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: cfg.apiKey ? `Bearer ${cfg.apiKey}` : '',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      let errorBody: unknown;
      try { errorBody = await res.json(); } catch { errorBody = await res.text(); }
      const err = new Error(`HTTP ${res.status} ${res.statusText}`);
      (err as Error & { status: number; body: unknown }).status = res.status;
      (err as Error & { status: number; body: unknown }).body   = errorBody;
      throw err;
    }

    const text = await res.text();
    return text ? JSON.parse(text) as T : ({} as T);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export const api = {
  get:    <T>(path: string, cfg?: Partial<ClientConfig>) => request<T>('GET', path, undefined, cfg),
  post:   <T>(path: string, body?: unknown, cfg?: Partial<ClientConfig>) => request<T>('POST', path, body, cfg),
  delete: <T>(path: string, cfg?: Partial<ClientConfig>) => request<T>('DELETE', path, undefined, cfg),
};

export { loadConfig };
