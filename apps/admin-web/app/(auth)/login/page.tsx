import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { setSessionCookies, getSessionUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'Sign in' };

async function loginAction(formData: FormData): Promise<void> {
  'use server';
  const email    = (formData.get('email')    as string | null)?.trim()  ?? '';
  const password = (formData.get('password') as string | null)          ?? '';
  const next     = (formData.get('next')     as string | null)          ?? '/';

  if (!email || !password) redirect('/login?error=missing_fields');

  const IDENTITY_URL = process.env['IDENTITY_URL'] ?? 'http://localhost:3110';
  let res: Response;
  try {
    res = await fetch(`${IDENTITY_URL}/api/v1/auth/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password }),
    });
  } catch {
    redirect('/login?error=unreachable');
  }

  if (!res.ok) redirect('/login?error=invalid_credentials');

  interface TokenResponse { access_token: string; refresh_token: string; }
  const { access_token, refresh_token } = await res.json() as TokenResponse;
  await setSessionCookies(access_token, refresh_token);
  redirect(next.startsWith('/') ? next : '/');
}

const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: 'Invalid email or password.',
  missing_fields:      'Email and password are required.',
  unreachable:         'Could not reach the identity service. Check service health.',
  expired:             'Your session expired. Please sign in again.',
};

interface SearchParams { error?: string; reason?: string; next?: string; }

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { error, reason, next } = await searchParams;

  // Already authenticated → redirect
  const user = await getSessionUser();
  if (user) redirect(next ?? '/');

  const errorMsg = error ? ERROR_MESSAGES[error] ?? 'An error occurred.' : null;
  const reasonMsg = reason === 'expired' ? ERROR_MESSAGES['expired'] : null;

  return (
    <main style={{ display: 'flex', justifyContent: 'center', paddingTop: '10vh' }}>
      <div style={{ width: 360 }}>
        <h1 style={{ marginBottom: '1.5rem' }}>Oweibo Admin</h1>

        {(errorMsg ?? reasonMsg) && (
          <p role="alert" style={{ color: '#c00', marginBottom: '1rem' }}>
            {errorMsg ?? reasonMsg}
          </p>
        )}

        <form action={loginAction} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <input type="hidden" name="next" value={next ?? '/'} />

          <label>
            <span style={{ display: 'block', marginBottom: 4, fontSize: 14 }}>Email</span>
            <input
              type="email"
              name="email"
              required
              autoComplete="email"
              style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box' }}
            />
          </label>

          <label>
            <span style={{ display: 'block', marginBottom: 4, fontSize: 14 }}>Password</span>
            <input
              type="password"
              name="password"
              required
              minLength={12}
              autoComplete="current-password"
              style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box' }}
            />
          </label>

          <button
            type="submit"
            style={{ padding: '0.6rem', background: '#1a1a1a', color: '#fff', border: 'none', cursor: 'pointer' }}
          >
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}
