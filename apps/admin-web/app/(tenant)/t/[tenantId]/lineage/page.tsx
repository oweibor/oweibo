import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { identityApi } from '@/lib/api';
import { getSessionToken } from '@/lib/auth';
import { fetchOrThrow } from '@/lib/serverFetch';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Lineage' };

interface LineageRow {
  childTenantId: string;
  parentTenantId: string;
  consentGrantId: string;
  clonedScopes: string[];
  createdAt: string;
}

interface Grant {
  id: string;
  parentTenantId: string;
  scopes: string[];
  childSlugPrefix: string | null;
  maxUses: number;
  uses: number;
  expiresAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface LineageResponse {
  asChild: LineageRow | null;
  asParent: LineageRow[];
}

const SCOPE_OPTIONS = [
  'memories', 'projects', 'org_graph', 'connectors_recommend', 'settings',
] as const;

async function createGrantAction(formData: FormData): Promise<void> {
  'use server';
  const tenantId = formData.get('tenantId') as string;
  const scopes = SCOPE_OPTIONS.filter((s) => formData.get(`scope:${s}`) === 'on');
  const childSlugPrefix = (formData.get('childSlugPrefix') as string) || undefined;
  const maxUsesRaw = formData.get('maxUses') as string;
  const maxUses = maxUsesRaw ? parseInt(maxUsesRaw, 10) : 1;
  // Default expiry: 30 days from now.
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const token = await getSessionToken();
  const IDENTITY_URL = process.env['IDENTITY_URL'] ?? 'http://localhost:3110';
  await fetchOrThrow('create lineage grant', `${IDENTITY_URL}/api/v1/tenants/${tenantId}/lineage/grants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      scopes,
      ...(childSlugPrefix ? { childSlugPrefix } : {}),
      maxUses,
      expiresAt,
    }),
  });
  redirect(`/t/${tenantId}/lineage`);
}

async function revokeGrantAction(formData: FormData): Promise<void> {
  'use server';
  const tenantId = formData.get('tenantId') as string;
  const grantId = formData.get('grantId') as string;
  const token = await getSessionToken();
  const IDENTITY_URL = process.env['IDENTITY_URL'] ?? 'http://localhost:3110';
  await fetchOrThrow('revoke lineage grant', `${IDENTITY_URL}/api/v1/tenants/${tenantId}/lineage/grants/${grantId}/revoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  redirect(`/t/${tenantId}/lineage`);
}

function grantState(g: Grant): { label: string; color: string } {
  if (g.revokedAt) return { label: 'revoked', color: '#525252' };
  if (g.consumedAt) return { label: 'consumed', color: '#525252' };
  if (new Date(g.expiresAt).getTime() < Date.now()) return { label: 'expired', color: '#525252' };
  if (g.uses >= g.maxUses) return { label: 'exhausted', color: '#525252' };
  return { label: 'active', color: '#065f46' };
}

export default async function LineagePage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;

  let lineage: LineageResponse | null = null;
  let grants: Grant[] = [];
  let fetchError: string | null = null;
  try {
    lineage = await identityApi.get<LineageResponse>(`/api/v1/tenants/${tenantId}/lineage`);
    const g = await identityApi.get<{ grants: Grant[] }>(`/api/v1/tenants/${tenantId}/lineage/grants`);
    grants = g.grants ?? [];
  } catch (err: any) {
    fetchError = err.message;
  }

  return (
    <>
      <PageHeader
        title="Lineage"
        subtitle="Parent/child tenant relationships and consent grants"
      />
      {fetchError && <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>}

      {lineage?.asChild && (
        <section style={{ marginBottom: '1.5rem' }}>
          <h3 style={{ marginBottom: '0.5rem', fontSize: 14, color: '#525252' }}>Parent</h3>
          <div style={{
            border: '1px solid #e5e5e5', borderRadius: 6, padding: '0.85rem 1rem',
          }}>
            <div style={{ fontFamily: 'monospace', fontSize: 13 }}>{lineage.asChild.parentTenantId}</div>
            <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
              cloned: {lineage.asChild.clonedScopes.join(', ')}
              <span style={{ marginLeft: '0.75rem' }}>
                {new Date(lineage.asChild.createdAt).toLocaleString()}
              </span>
            </div>
          </div>
        </section>
      )}

      {(lineage?.asParent.length ?? 0) > 0 && (
        <section style={{ marginBottom: '1.5rem' }}>
          <h3 style={{ marginBottom: '0.5rem', fontSize: 14, color: '#525252' }}>
            Child tenants ({lineage?.asParent.length})
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {lineage?.asParent.map((row) => (
              <div key={row.childTenantId} style={{
                border: '1px solid #e5e5e5', borderRadius: 6, padding: '0.75rem 1rem',
              }}>
                <div style={{ fontFamily: 'monospace', fontSize: 13 }}>{row.childTenantId}</div>
                <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
                  cloned: {row.clonedScopes.join(', ')}
                  <span style={{ marginLeft: '0.75rem' }}>
                    {new Date(row.createdAt).toLocaleString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section style={{ marginBottom: '1.5rem' }}>
        <h3 style={{ marginBottom: '0.5rem', fontSize: 14, color: '#525252' }}>
          Consent grants ({grants.length})
        </h3>
        {grants.length === 0 && (
          <p style={{ color: '#666', fontSize: 13 }}>
            No grants yet. Create one below to authorise a child-tenant creation.
          </p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {grants.map((g) => {
            const state = grantState(g);
            return (
              <div key={g.id} style={{
                border: '1px solid #e5e5e5', borderRadius: 6, padding: '0.75rem 1rem',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem',
              }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem' }}>
                    <span style={{
                      background: state.color, color: '#fff', fontSize: 10,
                      padding: '2px 6px', borderRadius: 3, textTransform: 'uppercase',
                    }}>{state.label}</span>
                    <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{g.id.slice(0, 8)}…</span>
                    <span style={{ fontSize: 12, color: '#888' }}>
                      {g.scopes.join(', ')}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                    uses {g.uses}/{g.maxUses}
                    {g.childSlugPrefix && <> · prefix <code>{g.childSlugPrefix}</code></>}
                    {' · expires '}{new Date(g.expiresAt).toLocaleString()}
                  </div>
                </div>
                {state.label === 'active' && (
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
          <div>
            <label style={{ fontSize: 12, color: '#525252', display: 'block', marginBottom: 4 }}>Scopes to clone</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
              {SCOPE_OPTIONS.map((s) => (
                <label key={s} style={{ fontSize: 13 }}>
                  <input type="checkbox" name={`scope:${s}`} defaultChecked={s === 'memories'} /> {s}
                </label>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '1rem' }}>
            <label style={{ fontSize: 12, color: '#525252', flex: 1 }}>
              Child slug prefix (optional)
              <input name="childSlugPrefix" placeholder="acme-" style={{
                display: 'block', width: '100%', padding: '0.35rem', marginTop: 4,
                border: '1px solid #ccc', borderRadius: 4, fontSize: 13,
              }} />
            </label>
            <label style={{ fontSize: 12, color: '#525252', width: 120 }}>
              Max uses
              <input name="maxUses" type="number" defaultValue="1" min="1" max="100" style={{
                display: 'block', width: '100%', padding: '0.35rem', marginTop: 4,
                border: '1px solid #ccc', borderRadius: 4, fontSize: 13,
              }} />
            </label>
          </div>
          <button type="submit" style={{
            alignSelf: 'flex-start', padding: '0.4rem 1rem',
            background: '#065f46', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13,
          }}>Create grant</button>
        </form>
      </section>
    </>
  );
}
