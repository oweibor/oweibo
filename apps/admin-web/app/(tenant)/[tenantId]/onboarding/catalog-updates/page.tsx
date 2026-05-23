import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { identityApi } from '@/lib/api';
import { getSessionToken } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Catalog updates' };

interface PendingUpdate {
  tenantId: string;
  seedId: string;
  fromCatalogVersion: string;
  toCatalogVersion: string;
  fromContentHash: string | null;
  toContentHash: string;
  changeKind: 'additive' | 'revision' | 'removal';
  previewPayload: Record<string, unknown> | null;
  detectedAt: string;
  resolvedAt: string | null;
  resolution: string | null;
}

const KIND_COLOR: Record<PendingUpdate['changeKind'], string> = {
  additive: '#065f46',
  revision: '#92400e',
  removal: '#991b1b',
};

async function resolveAction(formData: FormData): Promise<void> {
  'use server';
  const tenantId = formData.get('tenantId') as string;
  const seedId = formData.get('seedId') as string;
  const toContentHash = formData.get('toContentHash') as string;
  const resolution = formData.get('resolution') as string;
  const token = await getSessionToken();
  const IDENTITY_URL = process.env['IDENTITY_URL'] ?? 'http://localhost:3110';
  await fetch(`${IDENTITY_URL}/api/v1/tenants/${tenantId}/catalog-updates/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ seedId, toContentHash, resolution }),
  });
  redirect(`/t/${tenantId}/onboarding/catalog-updates`);
}

export default async function CatalogUpdatesPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;

  let updates: PendingUpdate[] = [];
  let fetchError: string | null = null;
  try {
    const result = await identityApi.get<{ updates: PendingUpdate[] }>(`/api/v1/tenants/${tenantId}/catalog-updates`);
    updates = result.updates ?? [];
  } catch (err: any) {
    fetchError = err.message;
  }

  return (
    <>
      <PageHeader
        title="Catalog updates"
        subtitle={`${updates.length} pending`}
      />
      {fetchError && <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>}
      {updates.length === 0 && !fetchError && (
        <p style={{ color: '#666', fontSize: 14 }}>
          No pending catalog updates. The reconciler runs daily; new seed
          revisions show up here when detected.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {updates.map((u) => (
          <div key={`${u.seedId}:${u.toContentHash}`} style={{
            border: '1px solid #e5e5e5', borderRadius: 6, padding: '0.85rem 1rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', marginBottom: 6 }}>
              <span style={{
                background: KIND_COLOR[u.changeKind], color: '#fff', fontSize: 10,
                padding: '2px 6px', borderRadius: 3, textTransform: 'uppercase',
              }}>{u.changeKind}</span>
              <span style={{ fontFamily: 'monospace', fontSize: 13 }}>{u.seedId}</span>
              <span style={{ fontSize: 12, color: '#888' }}>
                {u.fromCatalogVersion ? `${u.fromCatalogVersion} → ` : ''}
                {u.toCatalogVersion || '(removed)'}
              </span>
            </div>
            <div style={{ fontSize: 11, color: '#888', marginBottom: 8, fontFamily: 'monospace' }}>
              {u.fromContentHash ? `${u.fromContentHash.slice(0, 12)} → ` : ''}
              {u.toContentHash.slice(0, 12)}
              <span style={{ marginLeft: '0.75rem' }}>
                detected {new Date(u.detectedAt).toLocaleString()}
              </span>
            </div>
            {u.previewPayload && Object.keys(u.previewPayload).length > 0 && (
              <pre style={{
                background: '#f5f5f5', padding: '0.5rem', borderRadius: 4,
                fontSize: 11, overflow: 'auto', maxHeight: 200, margin: '0 0 0.5rem 0',
              }}>{JSON.stringify(u.previewPayload, null, 2)}</pre>
            )}
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <form action={resolveAction}>
                <input type="hidden" name="tenantId" value={tenantId} />
                <input type="hidden" name="seedId" value={u.seedId} />
                <input type="hidden" name="toContentHash" value={u.toContentHash} />
                <input type="hidden" name="resolution" value="installed" />
                <button type="submit" style={{
                  padding: '0.35rem 0.9rem', background: '#065f46', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13,
                }}>Install</button>
              </form>
              <form action={resolveAction}>
                <input type="hidden" name="tenantId" value={tenantId} />
                <input type="hidden" name="seedId" value={u.seedId} />
                <input type="hidden" name="toContentHash" value={u.toContentHash} />
                <input type="hidden" name="resolution" value="dismissed" />
                <button type="submit" style={{
                  padding: '0.35rem 0.9rem', background: '#fff', color: '#525252', border: '1px solid #ccc', cursor: 'pointer', fontSize: 13,
                }}>Dismiss</button>
              </form>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
