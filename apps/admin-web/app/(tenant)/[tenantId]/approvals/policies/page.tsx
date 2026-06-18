/**
 * S.4: multi-party approval policies admin page.
 *
 * Lists per-action-class quorum policies for the tenant (or shows that
 * the tenant inherits the platform default matrix). Operators can pin a
 * stricter quorum, toggle dissent veto, allow/forbid grants for a class.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { pipelineApi } from '@/lib/api';
import { getSessionToken } from '@/lib/auth';
import { fetchOrThrow } from '@/lib/serverFetch';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Approval policies' };

interface Policy {
  actionClass: string;
  quorum: number;
  dissentVetoes: boolean;
  allowGrants: boolean;
  maxGrantDurationSeconds: number;
  maxGrantActionCount: number;
  allowDelegation: boolean;
  source: 'tenant_override' | 'platform_default';
}

async function upsertPolicyAction(formData: FormData): Promise<void> {
  'use server';
  const tenantId = formData.get('tenantId') as string;
  const actionClass = formData.get('actionClass') as string;
  const quorum = parseInt((formData.get('quorum') as string) || '1', 10);
  const dissentVetoes = formData.get('dissentVetoes') === 'on';
  const allowGrants = formData.get('allowGrants') === 'on';
  const allowDelegation = formData.get('allowDelegation') === 'on';
  const maxGrantDurationSeconds = parseInt((formData.get('maxGrantDurationSeconds') as string) || '3600', 10);
  const maxGrantActionCount = parseInt((formData.get('maxGrantActionCount') as string) || '100', 10);

  const token = await getSessionToken();
  const PIPELINE_URL = process.env['PIPELINE_URL'] ?? 'http://localhost:3100/api/v1';
  await fetchOrThrow('update approval policy', `${PIPELINE_URL}/tenants/${tenantId}/approvals/policies`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      actionClass, quorum, dissentVetoes, allowGrants, allowDelegation,
      maxGrantDurationSeconds, maxGrantActionCount,
    }),
  });
  redirect(`/t/${tenantId}/approvals/policies`);
}

export default async function ApprovalPoliciesPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;

  let policies: Policy[] = [];
  let fetchError: string | null = null;
  try {
    const res = await pipelineApi.get<{ policies: Policy[] }>(`/tenants/${tenantId}/approvals/policies`);
    policies = res.policies ?? [];
  } catch (err: any) {
    fetchError = err.message;
  }

  return (
    <>
      <PageHeader
        title="Approval policies"
        subtitle="Per-class quorum, dissent veto, grant caps, and delegation rules"
      />
      {fetchError && <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>}

      <section style={{ marginBottom: '1.5rem' }}>
        <h3 style={{ marginBottom: '0.5rem', fontSize: 14, color: '#525252' }}>
          Policies ({policies.length})
        </h3>
        {policies.length === 0 && !fetchError && (
          <p style={{ color: '#666', fontSize: 13 }}>
            No tenant overrides yet — the platform default matrix applies.
            Add an override below to pin stricter behaviour for a class.
          </p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {policies.map((p) => (
            <div key={p.actionClass} style={{
              border: '1px solid #e5e5e5', borderRadius: 6, padding: '0.75rem 1rem',
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem' }}>
                <span style={{
                  background: p.source === 'tenant_override' ? '#065f46' : '#525252',
                  color: '#fff', fontSize: 10,
                  padding: '2px 6px', borderRadius: 3, textTransform: 'uppercase',
                }}>{p.source === 'tenant_override' ? 'override' : 'default'}</span>
                <span style={{ fontSize: 13, color: '#262626', fontWeight: 600 }}>{p.actionClass}</span>
              </div>
              <div style={{ fontSize: 12, color: '#525252', marginTop: 6, display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                <span>quorum: <strong>{p.quorum}</strong></span>
                <span>dissent vetoes: <strong>{p.dissentVetoes ? 'yes' : 'no'}</strong></span>
                <span>grants: <strong>{p.allowGrants ? 'allowed' : 'forbidden'}</strong></span>
                <span>delegation: <strong>{p.allowDelegation ? 'allowed' : 'forbidden'}</strong></span>
                {p.allowGrants && (
                  <span>
                    grant cap: <strong>{p.maxGrantActionCount} actions / {p.maxGrantDurationSeconds}s</strong>
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 style={{ marginBottom: '0.5rem', fontSize: 14, color: '#525252' }}>Upsert policy</h3>
        <form action={upsertPolicyAction} style={{
          border: '1px solid #e5e5e5', borderRadius: 6, padding: '1rem',
          display: 'flex', flexDirection: 'column', gap: '0.75rem',
        }}>
          <input type="hidden" name="tenantId" value={tenantId} />
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            <label style={{ fontSize: 12, color: '#525252', flex: 1, minWidth: 220 }}>
              Action class (or <code>*</code> for tenant default)
              <input name="actionClass" required placeholder="deploy.prod" style={{
                display: 'block', width: '100%', padding: '0.35rem', marginTop: 4,
                border: '1px solid #ccc', borderRadius: 4, fontSize: 13,
              }} />
            </label>
            <label style={{ fontSize: 12, color: '#525252', width: 100 }}>
              Quorum
              <input name="quorum" type="number" defaultValue="1" min="1" max="10" style={{
                display: 'block', width: '100%', padding: '0.35rem', marginTop: 4,
                border: '1px solid #ccc', borderRadius: 4, fontSize: 13,
              }} />
            </label>
          </div>
          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', fontSize: 13 }}>
            <label><input type="checkbox" name="dissentVetoes" defaultChecked /> dissent vetoes</label>
            <label><input type="checkbox" name="allowGrants" /> allow grants</label>
            <label><input type="checkbox" name="allowDelegation" defaultChecked /> allow delegation</label>
          </div>
          <div style={{ display: 'flex', gap: '1rem' }}>
            <label style={{ fontSize: 12, color: '#525252', flex: 1 }}>
              Max grant duration (seconds)
              <input name="maxGrantDurationSeconds" type="number" defaultValue="3600" min="60" max="86400" style={{
                display: 'block', width: '100%', padding: '0.35rem', marginTop: 4,
                border: '1px solid #ccc', borderRadius: 4, fontSize: 13,
              }} />
            </label>
            <label style={{ fontSize: 12, color: '#525252', flex: 1 }}>
              Max actions per grant
              <input name="maxGrantActionCount" type="number" defaultValue="100" min="1" max="1000" style={{
                display: 'block', width: '100%', padding: '0.35rem', marginTop: 4,
                border: '1px solid #ccc', borderRadius: 4, fontSize: 13,
              }} />
            </label>
          </div>
          <button type="submit" style={{
            alignSelf: 'flex-start', padding: '0.4rem 1rem',
            background: '#065f46', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13,
          }}>Save policy</button>
        </form>
      </section>
    </>
  );
}
