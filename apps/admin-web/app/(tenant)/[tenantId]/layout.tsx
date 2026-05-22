import type { ReactNode } from 'react';
import { requireAuth } from '@/lib/auth';
import { NavBar } from '@/components/NavBar';
import { TenantSwitcher } from '@/components/TenantSwitcher';
import { CalibrationBadge } from '@/components/CalibrationBadge';
import Link from 'next/link';

interface TenantLayoutProps {
  children:  ReactNode;
  params:    Promise<{ tenantId: string }>;
}

const TENANT_NAV: { label: string; href: (id: string) => string }[] = [
  { label: 'Dashboard',  href: id => `/t/${id}` },
  { label: 'Onboarding', href: id => `/t/${id}/onboarding` },
  { label: 'Members',    href: id => `/t/${id}/members` },
  { label: 'API Keys',   href: id => `/t/${id}/keys` },
  { label: 'Settings',   href: id => `/t/${id}/settings` },
  { label: 'Tasks',      href: id => `/t/${id}/tasks` },
  { label: 'Staging',    href: id => `/t/${id}/staging` },
  { label: 'Quarantine', href: id => `/t/${id}/quarantine` },
  { label: 'Actions',    href: id => `/t/${id}/actions/pending` },
];

export default async function TenantLayout({ children, params }: TenantLayoutProps) {
  const { tenantId } = await params;
  const user = await requireAuth();

  // Verify the user has access to this tenant
  if (
    !user.scopes.includes('tasks:read') &&
    !user.scopes.includes('platform:tenants:read')
  ) {
    const { redirect } = await import('next/navigation');
    redirect('/unauthorized');
  }

  return (
    <>
      <NavBar user={user} tenantId={tenantId} />

      {/* T.5.c: calibration status strip — shown across every tenant page */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '0.5rem',
        padding: '0.4rem 1.5rem', background: '#fafafa',
        borderBottom: '1px solid #e5e5e5', fontSize: 12, color: '#666',
      }}>
        <CalibrationBadge tenantId={tenantId} />
      </div>

      <div style={{ display: 'flex', minHeight: 'calc(100vh - 80px)' }}>
        {/* Sidebar */}
        <aside style={{
          width:      200,
          flexShrink: 0,
          background: '#f9f9f9',
          borderRight: '1px solid #e5e5e5',
          padding:    '1rem 0',
        }}>
          <div style={{ padding: '0 1rem 0.75rem', fontSize: 12, color: '#888', fontWeight: 600, textTransform: 'uppercase' }}>
            Tenant
          </div>

          <TenantSwitcher
            currentTenantId={tenantId}
            tenants={[{ tenantId, name: tenantId }]}
          />

          <nav style={{ marginTop: '0.5rem' }}>
            {TENANT_NAV.map(item => (
              <Link
                key={item.label}
                href={item.href(tenantId)}
                style={{
                  display: 'block',
                  padding: '0.45rem 1rem',
                  fontSize: 14,
                  color:   '#333',
                  textDecoration: 'none',
                }}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </aside>

        {/* Content */}
        <main style={{ flex: 1, padding: '1.5rem' }}>
          {children}
        </main>
      </div>
    </>
  );
}
