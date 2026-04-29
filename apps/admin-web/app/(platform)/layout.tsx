import type { ReactNode } from 'react';
import { requireScope } from '@/lib/auth';
import { NavBar } from '@/components/NavBar';

export default async function PlatformLayout({ children }: { children: ReactNode }) {
  const user = await requireScope('platform:tenants:read');
  return (
    <>
      <NavBar user={user} />
      <main style={{ maxWidth: 1100, margin: '0 auto', padding: '1.5rem' }}>
        {children}
      </main>
    </>
  );
}
