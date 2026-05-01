import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Access Denied' };

export default function UnauthorizedPage() {
  return (
    <main style={{ padding: '2rem', textAlign: 'center' }}>
      <h1>Access Denied</h1>
      <p>You do not have the required permissions to view this page.</p>
      <p>
        <Link href="/">Go to dashboard</Link>
        {' · '}
        <Link href="/logout">Sign out</Link>
      </p>
    </main>
  );
}
