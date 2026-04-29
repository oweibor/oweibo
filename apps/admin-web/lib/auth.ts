/**
 * lib/auth.ts — server-side session helpers.
 *
 * Only import from Server Components and Route Handlers (not middleware).
 * Middleware uses its own edge-safe inline decoder.
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export const SESSION_COOKIE  = 'oweibo_session';
export const REFRESH_COOKIE  = 'oweibo_refresh';

export interface SessionUser {
  user_id:   string;
  email:     string | null;
  tenant_id: string | null;
  scopes:    string[];
  trust:     string;
}

export function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const [, encoded] = token.split('.');
    if (!encoded) return null;
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function payloadToSessionUser(payload: Record<string, unknown>): SessionUser {
  return {
    user_id:   (payload['sub'] as string) ?? '',
    email:     (payload['email'] as string) ?? null,
    tenant_id: ((payload['ctx'] as any)?.tenantId as string) || null,
    scopes:    (payload['scopes'] as string[]) ?? [],
    trust:     (payload['trust'] as string) ?? 'supervised',
  };
}

/** Read the current session token from cookies. */
export async function getSessionToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(SESSION_COOKIE)?.value ?? null;
}

/** Read and parse the current session user. Returns null if not authenticated or expired. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const token = await getSessionToken();
  if (!token) return null;
  const payload = parseJwtPayload(token);
  if (!payload) return null;
  if (typeof payload['exp'] === 'number' && payload['exp'] < Date.now() / 1000) return null;
  return payloadToSessionUser(payload);
}

/** Require authentication — redirects to /login if not authenticated. */
export async function requireAuth(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  return user;
}

/** Require a specific scope — redirects to /unauthorized if scope is missing. */
export async function requireScope(scope: string): Promise<SessionUser> {
  const user = await requireAuth();
  if (!user.scopes.includes(scope)) redirect('/unauthorized');
  return user;
}

/** Set session cookies (call from route handlers / server actions). */
export async function setSessionCookies(
  accessToken: string,
  refreshToken: string,
  accessTtl = 900,
  refreshTtl = 30 * 24 * 60 * 60,
): Promise<void> {
  const jar = await cookies();
  const isProd = process.env['NODE_ENV'] === 'production';
  jar.set(SESSION_COOKIE, accessToken, {
    httpOnly: true,
    secure:   isProd,
    sameSite: 'strict',
    maxAge:   accessTtl,
    path:     '/',
  });
  jar.set(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure:   isProd,
    sameSite: 'strict',
    maxAge:   refreshTtl,
    path:     '/',
  });
}

/** Clear session cookies (logout). */
export async function clearSessionCookies(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  jar.delete(REFRESH_COOKIE);
}
