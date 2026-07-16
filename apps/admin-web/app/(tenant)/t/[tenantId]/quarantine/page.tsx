import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { pipelineApi } from '@/lib/api';
import { getSessionToken } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Quarantine' };

async function overrideAction(formData: FormData): Promise<void> {
  'use server';
  const id       = formData.get('id') as string;
  const tenantId = formData.get('tenantId') as string;
  const reason   = formData.get('reason') as string | null;
  const token    = await getSessionToken();
  const PIPELINE_URL = process.env['PIPELINE_URL'] ?? 'http://localhost:3100/api/v1';
  await fetch(`${PIPELINE_URL}/quarantine/${id}/override`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body:    JSON.stringify({ reason }),
  });
  redirect(`/t/${tenantId}/quarantine`);
}

export default async function QuarantinePage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  let items: any[] = [];
  let fetchError: string | null = null;
  try {
    const result = await pipelineApi.get<{ quarantined: any[]; count: number }>('/quarantine');
    items = result.quarantined ?? [];
  } catch (err: any) {
    fetchError = err.message;
  }

  return (
    <>
      <PageHeader title="Quarantine" subtitle={`${items.length} item${items.length !== 1 ? 's' : ''}`} />
      {fetchError && <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>}
      {items.length === 0 && !fetchError && <p>No quarantined items.</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {items.map((q: any) => (
          <div key={q.id} style={{ border: '1px solid #fecaca', borderRadius: 6, padding: '1rem', background: '#fff5f5' }}>
            <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#888', marginBottom: 4 }}>
              {q.id} · task: {q.taskId}
            </div>
            {q.reason && (
              <div style={{ fontSize: 13, color: '#991b1b', marginBottom: '0.75rem' }}>
                Reason: {q.reason}
              </div>
            )}
            <form action={overrideAction} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input type="hidden" name="id"       value={q.id} />
              <input type="hidden" name="tenantId" value={tenantId} />
              <input name="reason" type="text" placeholder="Override reason (required)"
                style={{ padding: '0.35rem 0.5rem', fontSize: 13, flex: 1 }} />
              <button type="submit" style={{
                padding: '0.35rem 0.9rem', background: '#1a1a1a', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13,
              }}>Override</button>
            </form>
          </div>
        ))}
      </div>
    </>
  );
}
