/**
 * S.4: time-windowed approval grants admin page.
 *
 * Lists active and historical grants for the tenant. Operators can create
 * new grants (bounded by per-class policy caps) or revoke active ones.
 *
 * Backed by the pipeline-side service which proxies to MultiPartyApprovalService.
 * If the endpoints are not yet wired the page degrades to "Failed to load",
 * matching the convention used by other actions admin pages.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { pipelineApi } from '@/lib/api';
import { getSessionToken } from '@/lib/auth';
import { fetchOrThrow } from '@/lib/serverFetch';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Approval grants' };

interface Grant {
  id: string;
  tenantId: string;
  actionClass: string;
  grantedByUserIds: string[];
  grantedToKind: 'agent' | 'user';
  grantedToUserId?: string | null;
  scopeFilter?: { fieldPath: string; operator: string; value: unknown } | null;
  expiresAt: string;
  maxUses: number;
  uses: number;
  state: 'active' | 'exhausted' | 'expired' | 'revoked';
  revokedAt?: string | null;
  createdAt: string;
}

async function createGrantAction(formData: FormData): Promise<void> {
  'use server';
  const tenantId = formData.get('tenantId') as string;
  const actionClass = formData.get('actionClass') as string;
  const durationSeconds = parseInt((formData.get('durationSeconds') as string) || '3600', 10);
  const maxUses = parseInt((formData.get('maxUses') as string) || '1', 10);
  const grantedToKind = (formData.get('grantedToKind') as string) || 'agent';
  const scopeFieldPath = (formData.get('scopeFieldPath') as string) || '';
  const scopeOperator = (formData.get('scopeOperator') as string) || 'eq';
  const scopeValue = (formData.get('scopeValue') as string) || '';

  const token = await getSessionToken();
  const PIPELINE_URL = process.env['PIPELINE_URL'] ?? 'http://localhost:3100/api/v1';
  await fetchOrThrow('create grant', `${PIPELINE_URL}/tenants/${tenantId}/approvals/grants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      actionClass,
      grantedToKind,
      durationSeconds,
      maxUses,
      ...(scopeFieldPath ? {
        scopeFilter: { fieldPath: scopeFieldPath, operator: scopeOperator, value: scopeValue },
      } : {}),
    }),
  });
  redirect(`/t/${tenantId}/approvals/grants`);
}

async function revokeGrantAction(formData: FormData): Promise<void> {
  'use server';
  const tenantId = formData.get('tenantId') as string;
  const grantId = formData.get('grantId') as string;
  const token = await getSessionToken();
  const PIPELINE_URL = process.env['PIPELINE_URL'] ?? 'http://localhost:3100/api/v1';
  await fetchOrThrow('revoke grant', `${PIPELINE_URL}/tenants/${tenantId}/approvals/grants/${grantId}/revoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  redirect(`/t/${tenantId}/approvals/grants`);
}

function stateBadge(g: Grant): { label: string; color: string } {
  if (g.state === 'active') return { label: 'active', color: '#065f46' };
  return { label: g.state, color: '#525252' };
}

export default async function ApprovalGrantsPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;

  let grants: Grant[] = [];
  let fetchError: string | null = null;
  try {
    const res = await pipelineApi.get<{ grants: Grant[] }>(`/tenants/${tenantId}/approvals/grants`);
    grants = res.grants ?? [];
  } catch (err: any) {
    fetchError = err.message;
  }

  return (
    <>
      <PageHeader
        title="Approval grants"
        subtitle="Time-windowed authorisations that auto-approve a class of actions"
      />
      {fetchError && <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>}

      <section style={{ marginBottom: '1.5rem' }}>
        <h3 style={{ marginBottom: '0.5rem', fontSize: 14, color: '#525252' }}>
          Grants ({grants.length})
        </h3>
        {grants.length === 0 && !fetchError && (
          <p style={{ color: '#666', fontSize: 13 }}>
            No grants yet. Create one below to skip per-action approval for a bounded window.
          </p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {grants.map((g) => {
            const badge = stateBadge(g);
            return (
              <div key={g.id} style={{
                border: '1px solid #e5e5e5', borderRadius: 6, padding: '0.75rem 1rem',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem',
              }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem' }}>
                    <span style={{
                      background: badge.color, color: '#fff', fontSize: 10,
                      padding: '2px 6px', borderRadius: 3, textTransform: 'uppercase',
                    }}>{badge.label}</span>
                    <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{g.id.slice(0, 8)}…</span>
                    <span style={{ fontSize: 13, color: '#262626' }}>{g.actionClass}</span>
                    <span style={{ fontSize: 12, color: '#888' }}>
                      {g.grantedToKind === 'agent' ? 'for agent' : `for user ${g.grantedToUserId?.slice(0, 8) ?? '?'}…`}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                    uses {g.uses}/{g.maxUses}
                    {' · expires '}{new Date(g.expiresAt).toLocaleString()}
                    {g.scopeFilter && (
                      <> · scope <code>{g.scopeFilter.fieldPath} {g.scopeFilter.operator} {JSON.stringify(g.scopeFilter.value)}</code></>
                    )}
                  </div>
                </div>
                {g.state === 'active' && (
                  <form action={revokeGrantAction}>
                    <input type="hidden" name="tenantId" value={tenantId} />
                    <input type="hidden" name="grantId" value={g.id} />
                    <button type="submit" style={{
                      padding: '0.25rem 0.75rem', background: '#fff', color: '#991b1b',
                      border: '1px solid #ccc', cursor: 'pointer', fontSize: 12,
                    }}>Revoke</button>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h3 style={{ marginBottom: '0.5rem', fontSize: 14, color: '#525252' }}>Create new grant</h3>
        <form action={createGrantAction} style={{
          border: '1px solid #e5e5e5', borderRadius: 6, padding: '1rem',
          display: 'flex', flexDirection: 'column', gap: '0.75rem',
        }}>
          <input type="hidden" name="tenantId" value={tenantId} />
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            <label style={{ fontSize: 12, color: '#525252', flex: 1, minWidth: 240 }}>
              Action class
              <input name="actionClass" required placeholder="write.tenant_db.prod" style={{
                display: 'block', width: '100%', padding: '0.35rem', marginTop: 4,
                border: '1px solid #ccc', borderRadius: 4, fontSize: 13,
              }} />
            </label>
            <label style={{ fontSize: 12, color: '#525252', width: 120 }}>
              Granted to
              <select name="grantedToKind" defaultValue="agent" style={{
                display: 'block', width: '100%', padding: '0.35rem', marginTop: 4,
                border: '1px solid #ccc', borderRadius: 4, fontSize: 13,
              }}>
                <option value="agent">agent</option>
                <option value="user">user</option>
              </select>
            </label>
            <label style={{ fontSize: 12, color: '#525252', width: 120 }}>
              Max uses
              <input name="maxUses" type="number" defaultValue="1" min="1" max="500" style={{
                display: 'block', width: '100%', padding: '0.35rem', marginTop: 4,
                border: '1px solid #ccc', borderRadius: 4, fontSize: 13,
              }} />
            </label>
            <label style={{ fontSize: 12, color: '#525252', width: 140 }}>
              Duration (seconds)
              <input name="durationSeconds" type="number" defaultValue="3600" min="60" max="86400" style={{
                display: 'block', width: '100%', padding: '0.35rem', marginTop: 4,
                border: '1px solid #ccc', borderRadius: 4, fontSize: 13,
              }} />
            </label>
          </div>
          <fieldset style={{ border: '1px solid #eee', borderRadius: 4, padding: '0.5rem 0.75rem' }}>
            <legend style={{ fontSize: 11, color: '#525252', padding: '0 0.25rem' }}>
              Optional scope filter
            </legend>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
              <label style={{ fontSize: 12, color: '#525252', flex: 1 }}>
                Field path
                <input name="scopeFieldPath" placeholder="payload.table" style={{
                  display: 'block', width: '100%', padding: '0.35rem', marginTop: 4,
                  border: '1px solid #ccc', borderRadius: 4, fontSize: 13,
                }} />
              </label>
              <label style={{ fontSize: 12, color: '#525252', width: 100 }}>
                Operator
                <select name="scopeOperator" defaultValue="eq" style={{
                  display: 'block', width: '100%', padding: '0.35rem', marginTop: 4,
                  border: '1px solid #ccc', borderRadius: 4, fontSize: 13,
                }}>
                  <option value="eq">eq</option>
                  <option value="in">in</option>
                  <option value="matches">matches</option>
                </select>
              </label>
              <label style={{ fontSize: 12, color: '#525252', flex: 1 }}>
                Value
                <input name="scopeValue" placeholder="users" style={{
                  display: 'block', width: '100%', padding: '0.35rem', marginTop: 4,
                  border: '1px solid #ccc', borderRadius: 4, fontSize: 13,
                }} />
              </label>
            </div>
          </fieldset>
          <button type="submit" style={{
            alignSelf: 'flex-start', padding: '0.4rem 1rem',
            background: '#065f46', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13,
          }}>Create grant</button>
        </form>
      </section>
    </>
  );
}
