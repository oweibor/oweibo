import { type NextRequest, NextResponse } from 'next/server';
import { clearSessionCookies, getSessionToken } from '@/lib/auth';

export async function GET(_req: NextRequest): Promise<NextResponse> {
  // Best-effort server-side logout
  const token = await getSessionToken();
  if (token) {
    const IDENTITY_URL = process.env['IDENTITY_URL'] ?? 'http://localhost:3110';
    fetch(`${IDENTITY_URL}/api/v1/auth/logout`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => undefined);
  }
  await clearSessionCookies();
  return NextResponse.redirect(new URL('/login', _req.url));
}

// Also handle POST so forms can submit to /logout
export { GET as POST };
