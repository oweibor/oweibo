import type { Metadata } from 'next';
import Link from 'next/link';
import { identityApi } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Tenants' };

interface Tenant {
  id:     string;
  name:   string;
  slug:   string;
  status: string;
  createdAt: string;
}

export default async function TenantsPage() {
  let tenants: Tenant[] = [];
  let fetchError: string | null = null;
  try {
    const result = await identityApi.get<{ tenants: Tenant[] }>('/api/v1/platform/tenants');
    tenants = result.tenants ?? [];
  } catch (err: any) {
    fetchError = err.message;
  }

  return (
    <>
      <PageHeader
        title="Tenants"
        subtitle={`${tenants.length} tenant${tenants.length !== 1 ? 's' : ''}`}
        actions={
          <Link href="/platform/tenants/new" style={{
            padding: '0.4rem 0.9rem', background: '#1a1a1a', color: '#fff',
            textDecoration: 'none', fontSize: 14, borderRadius: 4,
          }}>
            + New tenant
          </Link>
        }
      />

      {fetchError && <p style={{ color: '#c00' }}>Failed to load tenants: {fetchError}</p>}

      {tenants.length === 0 && !fetchError && <p>No tenants yet.</p>}

      {tenants.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e5e5', textAlign: 'left' }}>
              <th style={{ padding: '0.5rem 0.75rem' }}>Name</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Slug</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Status</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Created</th>
              <th style={{ padding: '0.5rem 0.75rem' }}></th>
            </tr>
          </thead>
          <tbody>
            {tenants.map(t => (
              <tr key={t.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={{ padding: '0.5rem 0.75rem', fontWeight: 500 }}>
                  <Link href={`/platform/tenants/${t.id}`}>{t.name}</Link>
                </td>
                <td style={{ padding: '0.5rem 0.75rem', color: '#666' }}>{t.slug}</td>
                <td style={{ padding: '0.5rem 0.75rem' }}>
                  <span style={{
                    fontSize: 12, padding: '2px 8px', borderRadius: 999,
                    background: t.status === 'active' ? '#d1fae5' : '#fee2e2',
                    color:      t.status === 'active' ? '#065f46' : '#991b1b',
                  }}>{t.status}</span>
                </td>
                <td style={{ padding: '0.5rem 0.75rem', color: '#666' }}>
                  {new Date(t.createdAt).toLocaleDateString()}
                </td>
                <td style={{ padding: '0.5rem 0.75rem' }}>
                  <Link href={`/t/${t.id}`} style={{ fontSize: 12, color: '#555' }}>Open →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
