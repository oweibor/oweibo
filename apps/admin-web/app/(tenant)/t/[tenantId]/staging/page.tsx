import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { pipelineApi } from '@/lib/api';
import { getSessionToken } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Staging' };

async function approveAction(formData: FormData): Promise<void> {
  'use server';
  const id       = formData.get('id') as string;
  const tenantId = formData.get('tenantId') as string;
  const token    = await getSessionToken();
  const PIPELINE_URL = process.env['PIPELINE_URL'] ?? 'http://localhost:3100/api/v1';
  await fetch(`${PIPELINE_URL}/staging/${id}/approve`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  redirect(`/t/${tenantId}/staging`);
}

async function rejectAction(formData: FormData): Promise<void> {
  'use server';
  const id       = formData.get('id') as string;
  const tenantId = formData.get('tenantId') as string;
  const token    = await getSessionToken();
  const PIPELINE_URL = process.env['PIPELINE_URL'] ?? 'http://localhost:3100/api/v1';
  await fetch(`${PIPELINE_URL}/staging/${id}/reject`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  redirect(`/t/${tenantId}/staging`);
}

export default async function StagingPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  let items: any[] = [];
  let fetchError: string | null = null;
  try {
    const result = await pipelineApi.get<{ staged: any[]; count: number }>('/staging');
    items = result.staged ?? [];
  } catch (err: any) {
    fetchError = err.message;
  }

  return (
    <>
      <PageHeader title="Staging Queue" subtitle={`${items.length} item${items.length !== 1 ? 's' : ''} pending review`} />
      {fetchError && <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>}
      {items.length === 0 && !fetchError && <p>No staged items pending review.</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {items.map((s: any) => (
          <div key={s.id} style={{ border: '1px solid #e5e5e5', borderRadius: 6, padding: '1rem' }}>
            <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#888', marginBottom: 4 }}>
              {s.id} · task: {s.taskId}
            </div>
            {s.createdAt && (
              <div style={{ fontSize: 13, color: '#666', marginBottom: '0.75rem' }}>
                {new Date(s.createdAt).toLocaleString()}
              </div>
            )}
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <form action={approveAction}>
                <input type="hidden" name="id"       value={s.id} />
                <input type="hidden" name="tenantId" value={tenantId} />
                <button type="submit" style={{
                  padding: '0.35rem 0.9rem', background: '#065f46', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13,
                }}>Approve</button>
              </form>
              <form action={rejectAction}>
                <input type="hidden" name="id"       value={s.id} />
                <input type="hidden" name="tenantId" value={tenantId} />
                <button type="submit" style={{
                  padding: '0.35rem 0.9rem', background: '#fff', color: '#c00', border: '1px solid #c00', cursor: 'pointer', fontSize: 13,
                }}>Reject</button>
              </form>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
