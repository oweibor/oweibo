'use client';
import Link from 'next/link';
import type { SessionUser } from '@/lib/auth';

interface NavBarProps {
  user:      SessionUser;
  tenantId?: string | null;
}

export function NavBar({ user, tenantId }: NavBarProps) {
  const isPlatformAdmin = user.scopes.includes('platform:tenants:read');
  const tid = tenantId ?? user.tenant_id;

  return (
    <nav style={{
      display:        'flex',
      alignItems:     'center',
      gap:            '1.5rem',
      padding:        '0.75rem 1.5rem',
      background:     '#1a1a1a',
      color:          '#fff',
      fontSize:       14,
    }}>
      <strong style={{ marginRight: 'auto' }}>
        <Link href="/" style={{ color: '#fff', textDecoration: 'none' }}>Oweibo Admin</Link>
      </strong>

      {isPlatformAdmin && (
        <Link href="/platform/tenants" style={{ color: '#ccc', textDecoration: 'none' }}>
          Platform
        </Link>
      )}

      {tid && (
        <Link href={`/t/${tid}`} style={{ color: '#ccc', textDecoration: 'none' }}>
          Tenant
        </Link>
      )}

      <span style={{ color: '#888', fontSize: 12 }}>{user.email ?? user.user_id}</span>

      <Link href="/logout" style={{ color: '#f88', textDecoration: 'none' }}>
        Sign out
      </Link>
    </nav>
  );
}
