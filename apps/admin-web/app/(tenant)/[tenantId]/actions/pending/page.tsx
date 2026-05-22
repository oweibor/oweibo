import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { pipelineApi } from '@/lib/api';
import { getSessionToken } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Pending actions' };

interface ProposalSummary {
  id: string;
  tenantId: string;
  userId: string | null;
  actionClass: string;
  actionId: string;
  mode: 'dry_run' | 'shadow' | 'require_approval';
  summary: string;
  rollbackKind: string | null;
  state: string;
  createdAt: string;
  expiresAt: string;
}

async function promoteAction(formData: FormData): Promise<void> {
  'use server';
  const id = formData.get('id') as string;
  const tenantId = formData.get('tenantId') as string;
  const outcome = (formData.get('outcome') as string) ?? 'success';
  const token = await getSessionToken();
  const PIPELINE_URL = process.env['PIPELINE_URL'] ?? 'http://localhost:3100/api/v1';
  await fetch(`${PIPELINE_URL}/actions/${id}/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ outcome }),
  });
  redirect(`/t/${tenantId}/actions/pending`);
}

async function rejectAction(formData: FormData): Promise<void> {
  'use server';
  const id = formData.get('id') as string;
  const tenantId = formData.get('tenantId') as string;
  const reason = (formData.get('reason') as string) || 'rejected by operator';
  const token = await getSessionToken();
  const PIPELINE_URL = process.env['PIPELINE_URL'] ?? 'http://localhost:3100/api/v1';
  await fetch(`${PIPELINE_URL}/actions/${id}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ reason }),
  });
  redirect(`/t/${tenantId}/actions/pending`);
}

const MODE_COLORS: Record<string, string> = {
  dry_run: '#7c2d12',
  shadow: '#1e3a8a',
  require_approval: '#991b1b',
};

const MODE_LABELS: Record<string, string> = {
  dry_run: 'Dry-run',
  shadow: 'Shadow',
  require_approval: 'Awaits approval',
};

export default async function PendingActionsPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  let items: ProposalSummary[] = [];
  let fetchError: string | null = null;
  try {
    const result = await pipelineApi.get<{ proposals: ProposalSummary[]; count: number }>('/actions/pending');
    items = result.proposals ?? [];
  } catch (err: any) {
    fetchError = err.message;
  }

  return (
    <>
      <PageHeader title="Pending actions" subtitle={`${items.length} action${items.length !== 1 ? 's' : ''} awaiting decision`} />
      {fetchError && <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>}
      {items.length === 0 && !fetchError && <p>No pending action proposals.</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {items.map((p) => (
          <div key={p.id} style={{ border: '1px solid #e5e5e5', borderRadius: 6, padding: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{
                background: MODE_COLORS[p.mode] ?? '#333',
                color: '#fff', fontSize: 11, padding: '2px 8px', borderRadius: 3,
              }}>{MODE_LABELS[p.mode] ?? p.mode}</span>
              <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#888' }}>{p.actionClass}</span>
            </div>
            <div style={{ fontSize: 14, marginBottom: 6 }}>{p.summary}</div>
            <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#888', marginBottom: 6 }}>
              {p.id}
              {p.rollbackKind && <> · rollback: {p.rollbackKind}</>}
              <> · created: {new Date(p.createdAt).toLocaleString()}</>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <form action={promoteAction} style={{ display: 'flex', gap: '0.5rem' }}>
                <input type="hidden" name="id" value={p.id} />
                <input type="hidden" name="tenantId" value={tenantId} />
                <input type="hidden" name="outcome" value="success" />
                <button type="submit" style={{
                  padding: '0.35rem 0.9rem', background: '#065f46', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13,
                }}>Promote (success)</button>
              </form>
              <form action={rejectAction} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <input type="hidden" name="id" value={p.id} />
                <input type="hidden" name="tenantId" value={tenantId} />
                <input name="reason" type="text" placeholder="Rejection reason"
                  style={{ padding: '0.35rem 0.5rem', fontSize: 13, minWidth: 200 }} />
                <button type="submit" style={{
                  padding: '0.35rem 0.9rem', background: '#fff', color: '#c00', border: '1px solid #c00', cursor: 'pointer', fontSize: 13,
                }}>Reject</button>
              </form>
              <a href={`/t/${tenantId}/actions/${p.id}`} style={{
                padding: '0.35rem 0.9rem', fontSize: 13, color: '#333',
                border: '1px solid #ddd', textDecoration: 'none',
              }}>Inspect</a>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
