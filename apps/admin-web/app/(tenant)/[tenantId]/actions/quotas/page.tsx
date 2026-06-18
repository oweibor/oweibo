/**
 * S.6: action quotas admin page.
 *
 * Lists per-(quota_kind, scope, window) caps and current consumption.
 * Operators can upsert a policy or temporarily lift a quota
 * (audited via action_proposals).
 *
 * Backed by pipeline-side endpoints which proxy to QuotaService.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { pipelineApi } from '@/lib/api';
import { getSessionToken } from '@/lib/auth';
import { fetchOrThrow } from '@/lib/serverFetch';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Action quotas' };

interface QuotaRow {
  quotaKind: string;
  scope: string;
  window: 'day' | 'month' | 'year';
  limit: number;
  consumed: number;
  resetAt: string;
  enforcementMode: 'soft' | 'hard';
  coldStartLimit?: number | null;
  coldStartDurationDays?: number;
}

async function upsertQuotaAction(formData: FormData): Promise<void> {
  'use server';
  const tenantId = formData.get('tenantId') as string;
  const quotaKind = formData.get('quotaKind') as string;
  const scope = (formData.get('scope') as string) || '*';
  const window = formData.get('window') as string;
  const limitValue = parseInt((formData.get('limitValue') as string) || '0', 10);
  const coldStartLimit = formData.get('coldStartLimit') as string;
  const coldStartDurationDays = parseInt((formData.get('coldStartDurationDays') as string) || '30', 10);
  const enforcementMode = (formData.get('enforcementMode') as string) || 'hard';

  const token = await getSessionToken();
  const PIPELINE_URL = process.env['PIPELINE_URL'] ?? 'http://localhost:3100/api/v1';
  await fetchOrThrow('update quota policy', `${PIPELINE_URL}/tenants/${tenantId}/actions/quotas`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      quotaKind, scope, window, limitValue,
      ...(coldStartLimit ? { coldStartLimit: parseInt(coldStartLimit, 10) } : {}),
      coldStartDurationDays, enforcementMode,
    }),
  });
  redirect(`/t/${tenantId}/actions/quotas`);
}

export default async function ActionQuotasPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;

  let quotas: QuotaRow[] = [];
  let fetchError: string | null = null;
  try {
    const res = await pipelineApi.get<{ quotas: QuotaRow[] }>(`/tenants/${tenantId}/actions/quotas`);
    quotas = res.quotas ?? [];
  } catch (err: any) {
    fetchError = err.message;
  }

  const grouped = groupByWindow(quotas);

  return (
    <>
      <PageHeader
        title="Action quotas"
        subtitle="Absolute caps over day / month / year windows (distinct from short-window rate limits)"
      />
      {fetchError && <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>}

      {(['day', 'month', 'year'] as const).map((win) => (
        <section key={win} style={{ marginBottom: '1.5rem' }}>
          <h3 style={{ marginBottom: '0.5rem', fontSize: 14, color: '#525252', textTransform: 'uppercase' }}>
            {win}ly ({grouped[win].length})
          </h3>
          {grouped[win].length === 0 && (
            <p style={{ color: '#666', fontSize: 13 }}>No {win}ly quotas configured.</p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {grouped[win].map((q, i) => (
              <div key={`${q.quotaKind}-${q.scope}-${i}`} style={{
                border: '1px solid #e5e5e5', borderRadius: 6, padding: '0.75rem 1rem',
              }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem' }}>
                  <span style={{
                    background: q.consumed >= q.limit ? '#991b1b' : (q.consumed >= q.limit * 0.8 ? '#b45309' : '#065f46'),
                    color: '#fff', fontSize: 10,
                    padding: '2px 6px', borderRadius: 3, textTransform: 'uppercase',
                  }}>{q.consumed >= q.limit ? 'exhausted' : (q.consumed >= q.limit * 0.8 ? 'warn' : 'ok')}</span>
                  <span style={{ fontSize: 13, color: '#262626', fontWeight: 600 }}>{q.quotaKind}</span>
                  <span style={{ fontSize: 12, color: '#888' }}>{q.scope === '*' ? '(total)' : q.scope}</span>
                  <span style={{
                    background: q.enforcementMode === 'hard' ? '#262626' : '#a3a3a3',
                    color: '#fff', fontSize: 10,
                    padding: '2px 6px', borderRadius: 3,
                  }}>{q.enforcementMode}</span>
                </div>
                <div style={{ fontSize: 12, color: '#525252', marginTop: 6 }}>
                  <strong>{q.consumed.toLocaleString()}</strong> / {q.limit.toLocaleString()}
                  <span style={{ marginLeft: '1rem', color: '#888' }}>
                    resets {new Date(q.resetAt).toLocaleString()}
                  </span>
                  {q.coldStartLimit != null && (
                    <span style={{ marginLeft: '1rem', color: '#888' }}>
                      cold-start cap {q.coldStartLimit.toLocaleString()} (first {q.coldStartDurationDays}d)
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      <section>
        <h3 style={{ marginBottom: '0.5rem', fontSize: 14, color: '#525252' }}>Upsert quota policy</h3>
        <form action={upsertQuotaAction} style={{
          border: '1px solid #e5e5e5', borderRadius: 6, padding: '1rem',
          display: 'flex', flexDirection: 'column', gap: '0.75rem',
        }}>
          <input type="hidden" name="tenantId" value={tenantId} />
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            <label style={{ fontSize: 12, color: '#525252', minWidth: 200 }}>
              Quota kind
              <select name="quotaKind" required style={{
                display: 'block', width: '100%', padding: '0.35rem', marginTop: 4,
                border: '1px solid #ccc', borderRadius: 4, fontSize: 13,
              }}>
                <option value="action_count_per_class">action_count_per_class</option>
                <option value="usd_cost_per_class">usd_cost_per_class</option>
                <option value="usd_cost_total">usd_cost_total</option>
                <option value="total_actions">total_actions</option>
                <option value="blast_radius_user_count">blast_radius_user_count</option>
              </select>
            </label>
            <label style={{ fontSize: 12, color: '#525252', flex: 1, minWidth: 180 }}>
              Scope (action class or *)
              <input name="scope" defaultValue="*" style={{
                display: 'block', width: '100%', padding: '0.35rem', marginTop: 4,
                border: '1px solid #ccc', borderRadius: 4, fontSize: 13,
              }} />
            </label>
            <label style={{ fontSize: 12, color: '#525252', width: 100 }}>
              Window
              <select name="window" required defaultValue="day" style={{
                display: 'block', width: '100%', padding: '0.35rem', marginTop: 4,
                border: '1px solid #ccc', borderRadius: 4, fontSize: 13,
              }}>
                <option value="day">day</option>
                <option value="month">month</option>
                <option value="year">year</option>
              </select>
            </label>
            <label style={{ fontSize: 12, color: '#525252', width: 140 }}>
              Limit value
              <input name="limitValue" type="number" required min="1" style={{
                display: 'block', width: '100%', padding: '0.35rem', marginTop: 4,
                border: '1px solid #ccc', borderRadius: 4, fontSize: 13,
              }} />
            </label>
          </div>
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            <label style={{ fontSize: 12, color: '#525252', width: 160 }}>
              Cold-start limit (optional)
              <input name="coldStartLimit" type="number" min="1" placeholder="leave blank" style={{
                display: 'block', width: '100%', padding: '0.35rem', marginTop: 4,
                border: '1px solid #ccc', borderRadius: 4, fontSize: 13,
              }} />
            </label>
            <label style={{ fontSize: 12, color: '#525252', width: 160 }}>
              Cold-start days
              <input name="coldStartDurationDays" type="number" defaultValue="30" min="0" max="365" style={{
                display: 'block', width: '100%', padding: '0.35rem', marginTop: 4,
                border: '1px solid #ccc', borderRadius: 4, fontSize: 13,
              }} />
            </label>
            <label style={{ fontSize: 12, color: '#525252', width: 140 }}>
              Enforcement
              <select name="enforcementMode" defaultValue="hard" style={{
                display: 'block', width: '100%', padding: '0.35rem', marginTop: 4,
                border: '1px solid #ccc', borderRadius: 4, fontSize: 13,
              }}>
                <option value="hard">hard</option>
                <option value="soft">soft</option>
              </select>
            </label>
          </div>
          <button type="submit" style={{
            alignSelf: 'flex-start', padding: '0.4rem 1rem',
            background: '#065f46', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13,
          }}>Save quota</button>
        </form>
      </section>
    </>
  );
}

function groupByWindow(rows: QuotaRow[]): Record<'day' | 'month' | 'year', QuotaRow[]> {
  const out: Record<'day' | 'month' | 'year', QuotaRow[]> = { day: [], month: [], year: [] };
  for (const r of rows) out[r.window].push(r);
  return out;
}
