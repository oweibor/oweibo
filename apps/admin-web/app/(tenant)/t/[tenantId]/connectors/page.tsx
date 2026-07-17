/**
 * Connectors admin page.
 *
 * Three sections:
 *  - installed instances (tenant_connectors rows);
 *  - the tenant's CUSTOM connector manifests (register / disable) —
 *    tenant-authored connectors the install flow accepts alongside the
 *    platform catalog. Custom connectors enter at the `experimental`
 *    certification tier, carry a mandatory `custom.` id prefix, and are
 *    governed downstream exactly like catalog entries (install-order gate,
 *    ADR-006 enablement policy, blue/green rollout);
 *  - a minimal install form (catalog id OR registered custom id).
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { pipelineApi } from '@/lib/api';
import { getSessionToken } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Connectors' };

const PIPELINE_URL = process.env['PIPELINE_URL'] ?? 'http://localhost:3100/api/v1';

interface InstalledConnector {
  id: string;
  connectorId: string;
  catalogVersion: string;
  instanceLabel: string;
  status: 'pending' | 'active' | 'suspended' | 'revoked';
  installedBy: string | null;
  installedAt: string;
  lastUsedAt: string | null;
}

interface CustomConnector {
  id: string;
  connectorId: string;
  displayName: string;
  category: string;
  description: string;
  catalogVersion: string;
  mcpServerUrl: string | null;
  declaredTools: string[];
  certificationTarget: string;
  status: 'registered' | 'disabled';
  createdAt: string;
}

const STATUS_COLOR: Record<InstalledConnector['status'], string> = {
  active: '#065f46',
  pending: '#92400e',
  suspended: '#525252',
  revoked: '#991b1b',
};

// ── Server actions ─────────────────────────────────────────────────────────

async function registerCustomAction(formData: FormData): Promise<void> {
  'use server';
  const tenantId = formData.get('tenantId') as string;

  let credentialSchema: unknown;
  try {
    credentialSchema = JSON.parse((formData.get('credentialSchema') as string) || '{"type":"object"}');
  } catch {
    redirect(`/t/${tenantId}/connectors?flash=${encodeURIComponent('Credential schema must be valid JSON')}`);
  }
  let capabilities: unknown;
  const capsRaw = (formData.get('capabilities') as string || '').trim();
  try {
    capabilities = capsRaw ? JSON.parse(capsRaw) : undefined;
  } catch {
    redirect(`/t/${tenantId}/connectors?flash=${encodeURIComponent('Capabilities must be a valid JSON array')}`);
  }
  const mcpServerUrl = (formData.get('mcpServerUrl') as string || '').trim();
  const declaredToolsRaw = (formData.get('declaredTools') as string || '').trim();
  const declaredTools = declaredToolsRaw
    ? declaredToolsRaw.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
    : [];

  const token = await getSessionToken();
  const res = await fetch(`${PIPELINE_URL}/tenants/${tenantId}/connectors/custom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      connectorId: formData.get('connectorId'),
      displayName: formData.get('displayName'),
      category: formData.get('category'),
      description: formData.get('description'),
      catalogVersion: formData.get('catalogVersion') || '1.0.0',
      credentialSchema,
      ...(capabilities !== undefined ? { capabilities } : {}),
      ...(mcpServerUrl ? { mcpServerUrl } : {}),
      ...(declaredTools.length > 0 ? { declaredTools } : {}),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  let flash: string;
  if (res.status === 201) {
    flash = `Registered ${String((body['connector'] as Record<string, unknown>)?.['connectorId'])} at the experimental tier.`;
  } else if (res.status === 400 && Array.isArray(body['violations'])) {
    const v = body['violations'] as Array<{ field: string; message: string }>;
    flash = `Manifest refused: ${v.map((x) => `${x.field} — ${x.message}`).join(' | ').slice(0, 500)}`;
  } else {
    flash = `Registration failed (${res.status}): ${JSON.stringify(body).slice(0, 300)}`;
  }
  redirect(`/t/${tenantId}/connectors?flash=${encodeURIComponent(flash)}`);
}

async function disableCustomAction(formData: FormData): Promise<void> {
  'use server';
  const tenantId = formData.get('tenantId') as string;
  const connectorId = formData.get('connectorId') as string;
  const token = await getSessionToken();
  const res = await fetch(
    `${PIPELINE_URL}/tenants/${tenantId}/connectors/custom/${encodeURIComponent(connectorId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  );
  const flash = res.status === 204
    ? `${connectorId} disabled — new installs are refused; existing instances remain for audit.`
    : `Disable failed (${res.status}).`;
  redirect(`/t/${tenantId}/connectors?flash=${encodeURIComponent(flash)}`);
}

async function installAction(formData: FormData): Promise<void> {
  'use server';
  const tenantId = formData.get('tenantId') as string;
  const token = await getSessionToken();
  const res = await fetch(`${PIPELINE_URL}/tenants/${tenantId}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      connectorId: formData.get('connectorId'),
      catalogVersion: formData.get('catalogVersion') || '1.0.0',
      instanceLabel: formData.get('instanceLabel') || 'primary',
      vaultPath: formData.get('vaultPath'),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const flash = res.status === 201
    ? `Installed ${String(formData.get('connectorId'))} (status pending).`
    : `Install failed (${res.status}): ${JSON.stringify(body).slice(0, 300)}`;
  redirect(`/t/${tenantId}/connectors?flash=${encodeURIComponent(flash)}`);
}

// ── Page ───────────────────────────────────────────────────────────────────

export default async function ConnectorsPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ flash?: string }>;
}) {
  const { tenantId } = await params;
  const { flash } = await searchParams;

  let installed: InstalledConnector[] = [];
  let fetchError: string | null = null;
  try {
    const result = await pipelineApi.get<{ connectors: InstalledConnector[] }>(`/tenants/${tenantId}/connectors`);
    installed = result.connectors ?? [];
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  let custom: CustomConnector[] = [];
  let customNote: string | null = null;
  try {
    const result = await pipelineApi.get<{ connectors: CustomConnector[] }>(`/tenants/${tenantId}/connectors/custom`);
    custom = result.connectors ?? [];
  } catch (err) {
    const status = (err as { status?: number }).status;
    customNote = status === 503
      ? 'Custom connectors are not configured on this deployment.'
      : `Failed to load custom connectors: ${err instanceof Error ? err.message : String(err)}`;
  }

  return (
    <>
      <PageHeader
        title="Connectors"
        subtitle={`${installed.length} installed · ${custom.length} custom manifest${custom.length === 1 ? '' : 's'}`}
      />
      {flash && (
        <p style={{
          border: '1px solid #d4d4d4', borderLeft: '4px solid #2563eb', borderRadius: 4,
          padding: '0.6rem 0.9rem', fontSize: 13, color: '#262626', background: '#f8fafc',
        }}>{flash}</p>
      )}
      {fetchError && <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>}

      {/* ── Installed instances ── */}
      <section style={{ marginBottom: '2rem' }}>
        <h3 style={{ marginBottom: '0.5rem', fontSize: 14, color: '#525252' }}>Installed</h3>
        {installed.length === 0 && !fetchError && (
          <p style={{ color: '#666', fontSize: 13 }}>No connectors installed yet.</p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {installed.map((c) => (
            <div key={c.id} style={{
              display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '0.75rem',
              border: '1px solid #eee', borderRadius: 4, padding: '0.6rem 0.85rem', alignItems: 'center',
            }}>
              <span>
                <span style={{ fontFamily: 'monospace', fontSize: 13 }}>{c.connectorId}</span>
                <span style={{ fontSize: 12, color: '#888', marginLeft: '0.5rem' }}>
                  · {c.instanceLabel}
                </span>
              </span>
              <span style={{
                background: STATUS_COLOR[c.status], color: '#fff', fontSize: 10,
                padding: '2px 6px', borderRadius: 3,
              }}>{c.status}</span>
              <span style={{ fontSize: 11, color: '#888' }}>
                v{c.catalogVersion}
                {c.lastUsedAt && ` · last used ${new Date(c.lastUsedAt).toLocaleDateString()}`}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ── Custom connector manifests ── */}
      <section style={{ marginBottom: '2rem' }}>
        <h3 style={{ marginBottom: '0.25rem', fontSize: 14, color: '#525252' }}>Custom connectors</h3>
        <p style={{ fontSize: 12, color: '#737373', marginBottom: '0.75rem' }}>
          Tenant-authored manifests, installable alongside the platform catalog. Ids carry the{' '}
          <code>custom.</code> prefix, the tier is pinned <code>experimental</code>, and downstream
          governance is unchanged — enabling one for writes is a dual-controlled policy relaxation.
        </p>
        {customNote && <p style={{ fontSize: 13, color: '#a16207' }}>{customNote}</p>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
          {custom.map((c) => (
            <div key={c.id} style={{ border: '1px solid #e5e5e5', borderRadius: 6, padding: '0.6rem 1rem' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', flexWrap: 'wrap' }}>
                <span style={{
                  background: c.status === 'registered' ? '#1e3a8a' : '#525252',
                  color: '#fff', fontSize: 10, padding: '2px 6px', borderRadius: 3, textTransform: 'uppercase',
                }}>{c.status}</span>
                <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 600 }}>{c.connectorId}</span>
                <span style={{ fontSize: 12, color: '#525252' }}>{c.displayName} · {c.category} · v{c.catalogVersion} · {c.certificationTarget}</span>
              </div>
              <div style={{ fontSize: 12, color: '#737373', marginTop: 4 }}>
                {c.description}
                {c.mcpServerUrl && (
                  <> · MCP: <code>{c.mcpServerUrl}</code> · declared tools: {c.declaredTools.join(', ') || '—'}</>
                )}
              </div>
              {c.status === 'registered' && (
                <form action={disableCustomAction} style={{ marginTop: 6 }}>
                  <input type="hidden" name="tenantId" value={tenantId} />
                  <input type="hidden" name="connectorId" value={c.connectorId} />
                  <button type="submit" style={{ padding: '0.25rem 0.7rem', fontSize: 12, color: '#7c2d12' }}>
                    Disable (refuse new installs)
                  </button>
                </form>
              )}
            </div>
          ))}
        </div>

        <details style={{ border: '1px solid #e5e5e5', borderRadius: 6, padding: '0.75rem 1rem' }}>
          <summary style={{ fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Register a custom connector</summary>
          <form action={registerCustomAction} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: 620, marginTop: '0.75rem' }}>
            <input type="hidden" name="tenantId" value={tenantId} />
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <label style={{ fontSize: 12, color: '#525252' }}>
                Connector id
                <input name="connectorId" required placeholder="custom.acme-tracker" style={{ display: 'block', marginTop: 2, padding: '0.3rem', fontSize: 13, width: 220 }} />
              </label>
              <label style={{ fontSize: 12, color: '#525252' }}>
                Display name
                <input name="displayName" required placeholder="Acme Tracker" style={{ display: 'block', marginTop: 2, padding: '0.3rem', fontSize: 13, width: 180 }} />
              </label>
              <label style={{ fontSize: 12, color: '#525252' }}>
                Category
                <select name="category" defaultValue="custom" style={{ display: 'block', marginTop: 2, padding: '0.3rem', fontSize: 13 }}>
                  {['custom', 'communication', 'source_control', 'database', 'storage', 'observability', 'payment', 'identity'].map((cat) => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: 12, color: '#525252' }}>
                Version
                <input name="catalogVersion" defaultValue="1.0.0" style={{ display: 'block', marginTop: 2, padding: '0.3rem', fontSize: 13, width: 80 }} />
              </label>
            </div>
            <label style={{ fontSize: 12, color: '#525252' }}>
              Description
              <input name="description" required placeholder="What this connector reaches and why" style={{ display: 'block', marginTop: 2, padding: '0.3rem', fontSize: 13, width: '100%' }} />
            </label>
            <label style={{ fontSize: 12, color: '#525252' }}>
              Credential schema (JSON Schema — renders the install credential form)
              <textarea name="credentialSchema" rows={2} defaultValue='{"type":"object","required":["api_key"],"properties":{"api_key":{"type":"string"}}}' style={{ display: 'block', width: '100%', marginTop: 2, fontFamily: 'monospace', fontSize: 12, padding: '0.4rem' }} />
            </label>
            <label style={{ fontSize: 12, color: '#525252' }}>
              Capabilities (JSON array, optional — each needs an actionClass; governance.* is refused)
              <textarea name="capabilities" rows={2} placeholder='[{"capabilityId":"create_ticket","summary":"Create a ticket","actionClass":"write.external_api.nonprod"}]' style={{ display: 'block', width: '100%', marginTop: 2, fontFamily: 'monospace', fontSize: 12, padding: '0.4rem' }} />
            </label>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <label style={{ fontSize: 12, color: '#525252', flex: 1 }}>
                MCP server URL (optional)
                <input name="mcpServerUrl" placeholder="https://mcp.acme.internal/tracker" style={{ display: 'block', marginTop: 2, padding: '0.3rem', fontSize: 13, width: '100%' }} />
              </label>
              <label style={{ fontSize: 12, color: '#525252', flex: 1 }}>
                Declared tools (comma-separated; the ONLY tools ever admitted)
                <input name="declaredTools" placeholder="tracker.search, tracker.create" style={{ display: 'block', marginTop: 2, padding: '0.3rem', fontSize: 13, width: '100%' }} />
              </label>
            </div>
            <div>
              <button type="submit" style={{ padding: '0.35rem 0.9rem', fontSize: 13, fontWeight: 600 }}>Register</button>
            </div>
          </form>
        </details>
      </section>

      {/* ── Install ── */}
      <section style={{ border: '1px solid #e5e5e5', borderRadius: 6, padding: '0.75rem 1rem' }}>
        <h3 style={{ marginBottom: '0.25rem', fontSize: 14, color: '#525252' }}>Install a connector</h3>
        <p style={{ fontSize: 12, color: '#737373', marginBottom: '0.5rem' }}>
          Accepts a platform catalog id or one of the registered custom ids above. Credentials are
          referenced by Vault path — they never transit or persist here.
        </p>
        <form action={installAction} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <input type="hidden" name="tenantId" value={tenantId} />
          <label style={{ fontSize: 12, color: '#525252' }}>
            Connector id
            <input name="connectorId" required placeholder="custom.acme-tracker" style={{ display: 'block', marginTop: 2, padding: '0.3rem', fontSize: 13, width: 200 }} />
          </label>
          <label style={{ fontSize: 12, color: '#525252' }}>
            Version
            <input name="catalogVersion" defaultValue="1.0.0" style={{ display: 'block', marginTop: 2, padding: '0.3rem', fontSize: 13, width: 80 }} />
          </label>
          <label style={{ fontSize: 12, color: '#525252' }}>
            Instance label
            <input name="instanceLabel" defaultValue="primary" style={{ display: 'block', marginTop: 2, padding: '0.3rem', fontSize: 13, width: 110 }} />
          </label>
          <label style={{ fontSize: 12, color: '#525252' }}>
            Vault path
            <input name="vaultPath" required placeholder="tenants/…/connectors/acme" style={{ display: 'block', marginTop: 2, padding: '0.3rem', fontSize: 13, width: 240 }} />
          </label>
          <button type="submit" style={{ padding: '0.35rem 0.9rem', fontSize: 13 }}>Install</button>
        </form>
      </section>
    </>
  );
}
