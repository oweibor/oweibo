import type { Metadata } from 'next';
import { identityApi } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Members' };

export default async function MembersPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  let members: any[] = [];
  let fetchError: string | null = null;
  try {
    const result = await identityApi.get<{ members: any[] }>(`/api/v1/tenants/${tenantId}/users`);
    members = result.members ?? [];
  } catch (err: any) {
    fetchError = err.message;
  }

  return (
    <>
      <PageHeader title="Members" subtitle={`${members.length} member${members.length !== 1 ? 's' : ''}`} />
      {fetchError && <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>}
      {members.length === 0 && !fetchError && <p>No members.</p>}
      {members.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e5e5', textAlign: 'left' }}>
              <th style={{ padding: '0.5rem 0.75rem' }}>Email</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Roles</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>User ID</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m: any) => (
              <tr key={m.userId} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={{ padding: '0.5rem 0.75rem', fontWeight: 500 }}>{m.user?.email ?? '—'}</td>
                <td style={{ padding: '0.5rem 0.75rem', color: '#555' }}>{(m.roles ?? []).join(', ')}</td>
                <td style={{ padding: '0.5rem 0.75rem', color: '#888', fontSize: 12 }}>{m.userId}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
