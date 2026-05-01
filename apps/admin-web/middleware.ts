/**
 * Next.js Edge Middleware — RBAC route guards.
 *
 * Runs before every non-static request.  Protects:
 *   /platform/*   → requires platform:tenants:read scope
 *   /t/*          → requires tasks:read scope (any tenant member)
 *   everything else (except /login, /logout, /unauthorized, /api/*) → requires authentication
 *
 * JWT is decoded without signature verification (edge runtime has no access to
 * the RS256 private key).  The API layer performs full verification on every
 * server-to-server call — middleware is a UX gate, not a security gate.
 */
import { NextResponse, type NextRequest } from 'next/server';

export const SESSION_COOKIE  = 'oweibo_session';

/** Decode a JWT payload without verifying the signature (edge-safe). */
function decodePayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2 || !parts[1]) return null;
    // Replace URL-safe chars, then decode base64
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isExpired(payload: Record<string, unknown>): boolean {
  return typeof payload['exp'] === 'number' && payload['exp'] < Date.now() / 1000;
}

function hasScope(payload: Record<string, unknown>, scope: string): boolean {
  const scopes = payload['scopes'];
  return Array.isArray(scopes) && scopes.includes(scope);
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  // Public routes — no auth required
  if (
    pathname.startsWith('/login') ||
    pathname.startsWith('/logout') ||
    pathname.startsWith('/unauthorized') ||
    pathname.startsWith('/api/')
  ) {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;

  if (!token) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(loginUrl);
  }

  const payload = decodePayload(token);

  if (!payload || isExpired(payload)) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('reason', 'expired');
    const res = NextResponse.redirect(loginUrl);
    res.cookies.delete(SESSION_COOKIE);
    return res;
  }

  // Platform group — requires platform:tenants:read
  if (pathname.startsWith('/platform')) {
    if (!hasScope(payload, 'platform:tenants:read')) {
      return NextResponse.redirect(new URL('/unauthorized', req.url));
    }
  }

  // Tenant group — requires tasks:read (basic tenant member)
  if (pathname.startsWith('/t/')) {
    if (!hasScope(payload, 'tasks:read') && !hasScope(payload, 'platform:tenants:read')) {
      return NextResponse.redirect(new URL('/unauthorized', req.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
