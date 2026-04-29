import type { Metadata } from 'next';
import { identityApi } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Platform Users' };

interface PlatformUser {
  id:             string;
  email:          string;
  platformRoles?: string[];
  status:         string;
}

export default async function PlatformUsersPage() {
  let users: PlatformUser[] = [];
  let fetchError: string | null = null;
  try {
    const result = await identityApi.get<{ users: PlatformUser[] }>('/api/v1/platform/users');
    users = result.users ?? [];
  } catch (err: any) {
    fetchError = err.message;
  }

  return (
    <>
      <PageHeader title="Platform Users" subtitle={`${users.length} user${users.length !== 1 ? 's' : ''}`} />

      {fetchError && <p style={{ color: '#c00' }}>Failed to load users: {fetchError}</p>}
      {users.length === 0 && !fetchError && <p>No platform users found.</p>}

      {users.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e5e5', textAlign: 'left' }}>
              <th style={{ padding: '0.5rem 0.75rem' }}>Email</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Platform roles</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Status</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>ID</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={{ padding: '0.5rem 0.75rem', fontWeight: 500 }}>{u.email}</td>
                <td style={{ padding: '0.5rem 0.75rem', color: '#555' }}>
                  {(u.platformRoles ?? []).join(', ') || '—'}
                </td>
                <td style={{ padding: '0.5rem 0.75rem' }}>{u.status}</td>
                <td style={{ padding: '0.5rem 0.75rem', color: '#888', fontSize: 12 }}>{u.id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
