import type { Metadata } from 'next';
import Link from 'next/link';
import { pipelineApi } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Tenant Dashboard' };

export default async function TenantDashboardPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;

  let taskStats: { count?: number; running?: number } = {};
  try {
    const result = await pipelineApi.get<{ tasks: any[]; count: number }>('/tasks?limit=1');
    taskStats = { count: result.count };
  } catch { /* pipeline may not be available */ }

  const cards: { label: string; value: string; href: string }[] = [
    { label: 'Tasks',      value: taskStats.count != null ? String(taskStats.count) : '—', href: `/t/${tenantId}/tasks` },
    { label: 'Members',    value: '→', href: `/t/${tenantId}/members` },
    { label: 'API Keys',   value: '→', href: `/t/${tenantId}/keys` },
    { label: 'Staging',    value: '→', href: `/t/${tenantId}/staging` },
    { label: 'Quarantine', value: '→', href: `/t/${tenantId}/quarantine` },
    { label: 'Settings',   value: '→', href: `/t/${tenantId}/settings` },
  ];

  return (
    <>
      <PageHeader title="Dashboard" subtitle={`Tenant: ${tenantId}`} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '1rem' }}>
        {cards.map(c => (
          <Link
            key={c.label}
            href={c.href}
            style={{
              display:        'block',
              padding:        '1.25rem',
              border:         '1px solid #e5e5e5',
              borderRadius:   6,
              textDecoration: 'none',
              color:          'inherit',
            }}
          >
            <div style={{ fontSize: 28, fontWeight: 700, marginBottom: 4 }}>{c.value}</div>
            <div style={{ fontSize: 14, color: '#666' }}>{c.label}</div>
          </Link>
        ))}
      </div>
    </>
  );
}
