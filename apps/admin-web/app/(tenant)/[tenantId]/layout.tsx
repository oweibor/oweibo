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

interface NavItem {
  label: string;
  href: (id: string) => string;
  /** Optional sub-items rendered indented under the parent link. */
  children?: { label: string; href: (id: string) => string }[];
}

const TENANT_NAV: NavItem[] = [
  { label: 'Dashboard',  href: id => `/t/${id}` },
  { label: 'Onboarding', href: id => `/t/${id}/onboarding` },
  { label: 'Calibration', href: id => `/t/${id}/calibration` },     // F.4.8 / F.4.6
  { label: 'Templates',   href: id => `/t/${id}/templates` },        // F.4.8 / F.4.7
  { label: 'Members',    href: id => `/t/${id}/members` },
  { label: 'API Keys',   href: id => `/t/${id}/keys` },
  { label: 'Settings',   href: id => `/t/${id}/settings` },
  { label: 'Tasks',      href: id => `/t/${id}/tasks` },
  { label: 'Staging',    href: id => `/t/${id}/staging` },
  { label: 'Quarantine', href: id => `/t/${id}/quarantine` },
  { label: 'Actions',    href: id => `/t/${id}/actions/pending` },
  { label: 'Connectors', href: id => `/t/${id}/connectors` },
  { label: 'Org',        href: id => `/t/${id}/org` },
  { label: 'Lineage',    href: id => `/t/${id}/lineage` }, // T.9
  {
    // F.4.8: domain admin surface — backs F.4.5 routes.
    label: 'Domains',    href: id => `/t/${id}/domains`,
    children: [
      { label: 'SME review', href: id => `/t/${id}/domains/sme-review` },
      { label: 'Depth',      href: id => `/t/${id}/domains/depth` },
      { label: 'Compliance', href: id => `/t/${id}/domains/compliance` },
    ],
  },
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
              <div key={item.label}>
                <Link
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
                {item.children?.map(child => (
                  <Link
                    key={child.label}
                    href={child.href(tenantId)}
                    style={{
                      display: 'block',
                      padding: '0.3rem 1rem 0.3rem 2rem',
                      fontSize: 12,
                      color:   '#666',
                      textDecoration: 'none',
                    }}
                  >
                    {child.label}
                  </Link>
                ))}
              </div>
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
