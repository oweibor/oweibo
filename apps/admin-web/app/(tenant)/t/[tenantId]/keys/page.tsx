import type { Metadata } from 'next';
import { identityApi } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'API Keys' };

export default async function ApiKeysPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  let keys: any[] = [];
  let fetchError: string | null = null;
  try {
    const result = await identityApi.get<{ keys: any[] }>(`/api/v1/tenants/${tenantId}/apikeys`);
    keys = result.keys ?? [];
  } catch (err: any) {
    fetchError = err.message;
  }

  return (
    <>
      <PageHeader title="API Keys" subtitle={`${keys.length} key${keys.length !== 1 ? 's' : ''} (active)`} />
      {fetchError && <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>}
      {keys.length === 0 && !fetchError && (
        <p>No API keys. Create one with <code>oweibo tenant key create --name ci-key --scopes tasks:write</code></p>
      )}
      {keys.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e5e5', textAlign: 'left' }}>
              <th style={{ padding: '0.5rem 0.75rem' }}>Name</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Prefix</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Scopes</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Expires</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k: any) => (
              <tr key={k.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={{ padding: '0.5rem 0.75rem', fontWeight: 500 }}>{k.name}</td>
                <td style={{ padding: '0.5rem 0.75rem', fontFamily: 'monospace', fontSize: 12 }}>{k.prefix}…</td>
                <td style={{ padding: '0.5rem 0.75rem', color: '#555', fontSize: 12 }}>{(k.scopes ?? []).join(', ')}</td>
                <td style={{ padding: '0.5rem 0.75rem', color: '#888' }}>
                  {k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : 'Never'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
