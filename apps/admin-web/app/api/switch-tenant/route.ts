/**
 * POST /api/switch-tenant
 *
 * Called by TenantSwitcher (client component) to swap the active tenant.
 * Forwards the current session token to the identity service's switch-tenant
 * endpoint, which re-mints an access token scoped to the requested tenant.
 * The new token replaces the session cookie.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getSessionToken, setSessionCookies, SESSION_COOKIE } from '@/lib/auth';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { tenantId } = await req.json() as { tenantId?: string };
  if (!tenantId) {
    return NextResponse.json({ error: 'tenantId required' }, { status: 400 });
  }

  const token = await getSessionToken();
  if (!token) {
    return NextResponse.json({ error: 'not_authenticated' }, { status: 401 });
  }

  const IDENTITY_URL = process.env['IDENTITY_URL'] ?? 'http://localhost:3110';
  const res = await fetch(`${IDENTITY_URL}/api/v1/auth/switch-tenant`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body:    JSON.stringify({ tenantId }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    return NextResponse.json(body, { status: res.status });
  }

  interface SwitchResponse { access_token: string; expires_at: string; }
  const { access_token, expires_at } = await res.json() as SwitchResponse;

  const response = NextResponse.json({ ok: true, tenant_id: tenantId });

  // Re-read the current refresh token so we don't lose it
  const jar = req.cookies;
  const refreshToken = jar.get('oweibo_refresh')?.value ?? '';

  response.cookies.set(SESSION_COOKIE, access_token, {
    httpOnly: true,
    secure:   process.env['NODE_ENV'] === 'production',
    sameSite: 'strict',
    maxAge:   900,
    path:     '/',
  });

  void expires_at; // used implicitly via maxAge=900
  void refreshToken; // kept in browser; not rotated on tenant switch

  return response;
}
