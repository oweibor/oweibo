import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { pipelineApi } from '@/lib/api';
import { getSessionToken } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Trust matrix' };

interface MatrixRow {
  actionClass: string;
  currentMode: string;
  pinnedBy: string | null;
  pinnedReason: string | null;
  observations: number;
  successes: number;
  rejections: number;
  lastUpdated: string;
}

async function pinAction(formData: FormData): Promise<void> {
  'use server';
  const tenantId = formData.get('tenantId') as string;
  const actionClass = formData.get('actionClass') as string;
  const mode = formData.get('mode') as string;
  const reason = (formData.get('reason') as string) || 'operator pin';
  const token = await getSessionToken();
  const PIPELINE_URL = process.env['PIPELINE_URL'] ?? 'http://localhost:3100/api/v1';
  await fetch(`${PIPELINE_URL}/actions/trust-matrix/pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ actionClass, mode, reason }),
  });
  redirect(`/t/${tenantId}/actions/trust-matrix`);
}

async function unpinAction(formData: FormData): Promise<void> {
  'use server';
  const tenantId = formData.get('tenantId') as string;
  const actionClass = formData.get('actionClass') as string;
  const token = await getSessionToken();
  const PIPELINE_URL = process.env['PIPELINE_URL'] ?? 'http://localhost:3100/api/v1';
  await fetch(`${PIPELINE_URL}/actions/trust-matrix/unpin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ actionClass }),
  });
  redirect(`/t/${tenantId}/actions/trust-matrix`);
}

export default async function TrustMatrixPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;

  let rows: MatrixRow[] = [];
  let fetchError: string | null = null;
  try {
    const result = await pipelineApi.get<{ rows: MatrixRow[]; count: number }>('/actions/trust-matrix');
    rows = result.rows ?? [];
  } catch (err: any) {
    fetchError = err.message;
  }

  return (
    <>
      <PageHeader
        title="Trust matrix"
        subtitle={`${rows.length} explicit class state${rows.length !== 1 ? 's' : ''} · unspecified classes fall back to the platform-default matrix`}
      />
      {fetchError && <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>}
      {rows.length === 0 && !fetchError && (
        <p style={{ color: '#666' }}>
          No explicit class state for this tenant. All action classes resolve via the platform-default matrix.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {rows.map((r) => (
          <div key={r.actionClass} style={{ border: '1px solid #e5e5e5', borderRadius: 6, padding: '0.75rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontFamily: 'monospace', fontSize: 13 }}>{r.actionClass}</span>
              <span style={{
                background: '#1a1a1a', color: '#fff', fontSize: 11, padding: '2px 8px', borderRadius: 3,
              }}>{r.currentMode}</span>
            </div>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>
              obs {r.observations} · success {r.successes} · reject {r.rejections}
              {r.pinnedBy && <> · pinned by {r.pinnedBy}{r.pinnedReason ? `: ${r.pinnedReason}` : ''}</>}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <form action={pinAction} style={{ display: 'flex', gap: '0.3rem' }}>
                <input type="hidden" name="tenantId" value={tenantId} />
                <input type="hidden" name="actionClass" value={r.actionClass} />
                <select name="mode" defaultValue={r.currentMode} style={{ padding: '0.3rem', fontSize: 12 }}>
                  <option value="execute">execute</option>
                  <option value="dry_run">dry_run</option>
                  <option value="shadow">shadow</option>
                  <option value="require_approval">require_approval</option>
                  <option value="forbidden">forbidden</option>
                </select>
                <input name="reason" type="text" placeholder="Pin reason"
                  style={{ padding: '0.3rem 0.5rem', fontSize: 12, minWidth: 180 }} />
                <button type="submit" style={{
                  padding: '0.3rem 0.7rem', background: '#1a1a1a', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 12,
                }}>Pin</button>
              </form>
              {r.pinnedBy && (
                <form action={unpinAction}>
                  <input type="hidden" name="tenantId" value={tenantId} />
                  <input type="hidden" name="actionClass" value={r.actionClass} />
                  <button type="submit" style={{
                    padding: '0.3rem 0.7rem', background: '#fff', color: '#333', border: '1px solid #ccc', cursor: 'pointer', fontSize: 12,
                  }}>Unpin</button>
                </form>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
