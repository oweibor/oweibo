import type { Metadata } from 'next';
import { identityApi } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Connectors' };

interface InstalledConnector {
  id: string;
  connectorId: string;
  catalogVersion: string;
  instanceLabel: string;
  status: 'pending' | 'active' | 'suspended' | 'revoked';
  installedBy: string | null;
  installedAt: string;
  lastUsedAt: string | null;
}

const STATUS_COLOR: Record<InstalledConnector['status'], string> = {
  active: '#065f46',
  pending: '#92400e',
  suspended: '#525252',
  revoked: '#991b1b',
};

export default async function ConnectorsPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;

  let installed: InstalledConnector[] = [];
  let fetchError: string | null = null;
  try {
    const result = await identityApi.get<{ connectors: InstalledConnector[] }>(`/api/v1/tenants/${tenantId}/connectors`);
    installed = result.connectors ?? [];
  } catch (err: any) {
    fetchError = err.message;
  }

  return (
    <>
      <PageHeader
        title="Connectors"
        subtitle={`${installed.length} installed`}
      />
      {fetchError && <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>}
      {installed.length === 0 && !fetchError && (
        <p style={{ color: '#666', fontSize: 14 }}>
          No connectors installed yet. The install wizard ships in a follow-up phase;
          for now the catalog is browseable in the recommended list emitted by{' '}
          <a href={`/t/${tenantId}/onboarding`} style={{ color: '#1e3a8a' }}>seed_connectors</a>{' '}
          on the onboarding page.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {installed.map((c) => (
          <div key={c.id} style={{
            display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '0.75rem',
            border: '1px solid #eee', borderRadius: 4, padding: '0.6rem 0.85rem', alignItems: 'center',
          }}>
            <span>
              <span style={{ fontFamily: 'monospace', fontSize: 13 }}>{c.connectorId}</span>
              <span style={{ fontSize: 12, color: '#888', marginLeft: '0.5rem' }}>
                · {c.instanceLabel}
              </span>
            </span>
            <span style={{
              background: STATUS_COLOR[c.status], color: '#fff', fontSize: 10,
              padding: '2px 6px', borderRadius: 3,
            }}>{c.status}</span>
            <span style={{ fontSize: 11, color: '#888' }}>
              v{c.catalogVersion}
              {c.lastUsedAt && ` · last used ${new Date(c.lastUsedAt).toLocaleDateString()}`}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
