import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { identityApi } from '@/lib/api';
import { getSessionToken } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Tenant Detail' };

async function suspendAction(formData: FormData): Promise<void> {
  'use server';
  const id    = formData.get('id') as string;
  const token = await getSessionToken();
  const IDENTITY_URL = process.env['IDENTITY_URL'] ?? 'http://localhost:3110';
  await fetch(`${IDENTITY_URL}/api/v1/platform/tenants/${id}/suspend`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  redirect(`/platform/tenants/${id}`);
}

export default async function TenantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let tenant: any = null;
  let fetchError: string | null = null;
  try {
    const result = await identityApi.get<{ tenant: any }>(`/api/v1/platform/tenants/${id}`);
    tenant = result.tenant;
  } catch (err: any) {
    fetchError = err.message;
  }

  if (!tenant && !fetchError) fetchError = 'Tenant not found';

  return (
    <>
      <PageHeader
        title={tenant?.name ?? id}
        subtitle={`slug: ${tenant?.slug ?? '—'}`}
        actions={
          <Link href="/platform/tenants" style={{ fontSize: 14, color: '#555' }}>
            ← Back to tenants
          </Link>
        }
      />

      {fetchError && <p style={{ color: '#c00' }}>{fetchError}</p>}

      {tenant && (
        <>
          <dl style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: '0.5rem 1rem', fontSize: 14 }}>
            {[
              ['ID',         tenant.id],
              ['Status',     tenant.status],
              ['Trust mode', tenant.trustModeDefault],
              ['Created',    new Date(tenant.createdAt).toLocaleString()],
            ].map(([k, v]) => (
              <>
                <dt key={`k-${k}`} style={{ color: '#666', margin: 0 }}>{k}</dt>
                <dd key={`v-${k}`} style={{ margin: 0, fontWeight: 500 }}>{v ?? '—'}</dd>
              </>
            ))}
          </dl>

          <div style={{ marginTop: '2rem', display: 'flex', gap: '0.75rem' }}>
            <Link href={`/t/${tenant.id}`} style={{
              padding: '0.4rem 0.9rem', background: '#1a1a1a', color: '#fff', textDecoration: 'none', fontSize: 14,
            }}>
              Manage tenant →
            </Link>

            {tenant.status === 'active' && (
              <form action={suspendAction}>
                <input type="hidden" name="id" value={tenant.id} />
                <button type="submit" style={{
                  padding: '0.4rem 0.9rem', background: '#fff', color: '#c00',
                  border: '1px solid #c00', cursor: 'pointer', fontSize: 14,
                }}>
                  Suspend
                </button>
              </form>
            )}
          </div>
        </>
      )}
    </>
  );
}
