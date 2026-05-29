/**
 * F.4.8 / F.4.5: domains admin page.
 *
 * Tabbed view backed by the F.4.5 routes:
 *   - "Bindings" tab — GET /tenants/:tenantId/domains/bindings
 *   - "Registry"  tab — GET /tenants/:tenantId/domains/registry
 *
 * Tab selection rides a `?tab=` search param so the URL is shareable.
 * The bindings tab includes an inline form that PUTs a new binding set
 * via a server action; on success the per-tenant lookup cache flushes
 * server-side (the route handler invokes invalidate()).
 *
 * Empty/error states mirror the forensics page convention: muted prose
 * when there are no rows, red error line when the fetch threw.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { pipelineApi } from '@/lib/api';
import { getSessionToken } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Domains' };

interface DomainEntry {
  slug: string;
  displayName: string;
  description: string;
  category: 'regulated' | 'professional' | 'technical' | 'creative';
  maturity: 'experimental' | 'beta' | 'general_availability' | 'deprecated';
  compliancePostures: string[];
  archetypeRoles: string[];
  typicalConnectors: string[];
}

interface TenantBinding {
  tenantId: string;
  domainSlug: string;
  role: 'primary' | 'secondary';
  weight: number;
  rawWeight: number;
  boundBy: { type: 'classifier' | 'admin' | 'sme'; id: string };
  confidence: number | null;
  boundAt: string;
}

type Tab = 'bindings' | 'registry';

async function replaceBindingsAction(formData: FormData): Promise<void> {
  'use server';
  const tenantId = formData.get('tenantId') as string;
  const slugs = formData.getAll('slug').filter((s): s is string => typeof s === 'string' && s.length > 0);
  const rolesRaw = formData.getAll('role').filter((s): s is string => typeof s === 'string');
  const weightsRaw = formData.getAll('rawWeight').filter((s): s is string => typeof s === 'string');
  const userId = formData.get('userId') as string;

  const bindings = slugs.map((domainSlug, i) => ({
    domainSlug,
    role: (rolesRaw[i] ?? 'secondary') as 'primary' | 'secondary',
    rawWeight: Number(weightsRaw[i] ?? '1'),
    boundBy: { type: 'admin' as const, id: userId },
  })).filter((b) => Number.isFinite(b.rawWeight));

  const token = await getSessionToken();
  const PIPELINE_URL = process.env['PIPELINE_URL'] ?? 'http://localhost:3100/api/v1';
  await fetch(`${PIPELINE_URL}/tenants/${tenantId}/domains/bindings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ bindings }),
  });
  redirect(`/t/${tenantId}/domains?tab=bindings`);
}

export default async function DomainsPage({
  params, searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tenantId } = await params;
  const { tab: rawTab } = await searchParams;
  const tab: Tab = rawTab === 'registry' ? 'registry' : 'bindings';

  let bindings: TenantBinding[] = [];
  let registry: DomainEntry[] = [];
  let fetchError: string | null = null;
  try {
    if (tab === 'bindings') {
      const res = await pipelineApi.get<{ bindings: TenantBinding[] }>(
        `/tenants/${tenantId}/domains/bindings`,
      );
      bindings = res.bindings ?? [];
      // Registry preloaded for the dropdown choices in the inline form.
      const reg = await pipelineApi.get<{ entries: DomainEntry[] }>(
        `/tenants/${tenantId}/domains/registry`,
      );
      registry = reg.entries ?? [];
    } else {
      const reg = await pipelineApi.get<{ entries: DomainEntry[] }>(
        `/tenants/${tenantId}/domains/registry`,
      );
      registry = reg.entries ?? [];
    }
  } catch (err: unknown) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  return (
    <>
      <PageHeader
        title="Domains"
        subtitle="Per-tenant domain bindings and the canonical platform taxonomy"
      />

      <Tabs current={tab} tenantId={tenantId} />

      {fetchError && (
        <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>
      )}

      {tab === 'bindings' && (
        <BindingsTab tenantId={tenantId} bindings={bindings} registry={registry} />
      )}
      {tab === 'registry' && <RegistryTab entries={registry} />}
    </>
  );
}

// ── Tab bar ───────────────────────────────────────────────────────────────

function Tabs({ current, tenantId }: { current: Tab; tenantId: string }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: 'bindings', label: 'Bindings' },
    { id: 'registry', label: 'Registry' },
  ];
  return (
    <div style={{
      display: 'flex', gap: '0.5rem', marginBottom: '1.25rem',
      borderBottom: '1px solid #e5e5e5',
    }}>
      {tabs.map((t) => (
        <Link
          key={t.id}
          href={`/t/${tenantId}/domains?tab=${t.id}`}
          style={{
            padding: '0.5rem 1rem', fontSize: 13,
            color: current === t.id ? '#1e3a8a' : '#525252',
            textDecoration: 'none',
            borderBottom: current === t.id ? '2px solid #1e3a8a' : '2px solid transparent',
            marginBottom: -1,
          }}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}

// ── Bindings tab ──────────────────────────────────────────────────────────

function BindingsTab({
  tenantId, bindings, registry,
}: { tenantId: string; bindings: TenantBinding[]; registry: DomainEntry[] }) {
  const slugChoices = registry.map((e) => e.slug);

  return (
    <>
      <section style={{ marginBottom: '1.5rem' }}>
        <h3 style={{ marginBottom: '0.5rem', fontSize: 14, color: '#525252' }}>
          Active bindings ({bindings.length})
        </h3>
        {bindings.length === 0 && (
          <p style={{ color: '#666', fontSize: 13 }}>
            No bindings yet. Choose one or more domains below to bind this tenant.
            A binding affects rubric resolution, compliance rule packs, and
            connector recommendations.
          </p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {bindings.map((b) => (
            <div key={`${b.domainSlug}-${b.role}`} style={{
              display: 'grid', gridTemplateColumns: '1fr auto auto auto',
              gap: '0.75rem', alignItems: 'center',
              border: '1px solid #e5e5e5', borderRadius: 6,
              padding: '0.7rem 1rem',
            }}>
              <span style={{ fontFamily: 'monospace', fontSize: 13 }}>
                {b.domainSlug}
              </span>
              <span style={{
                background: b.role === 'primary' ? '#065f46' : '#525252',
                color: '#fff', fontSize: 10, padding: '2px 6px', borderRadius: 3,
                textTransform: 'uppercase',
              }}>{b.role}</span>
              <span style={{ fontSize: 11, color: '#888' }}>
                weight {b.weight.toFixed(2)} (raw {b.rawWeight.toFixed(2)})
              </span>
              <span style={{ fontSize: 11, color: '#888' }}>
                by {b.boundBy.type}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 style={{ marginBottom: '0.5rem', fontSize: 14, color: '#525252' }}>
          Replace bindings
        </h3>
        <p style={{ color: '#888', fontSize: 12, marginTop: 0, marginBottom: '0.75rem' }}>
          PUT semantics: this form replaces the full binding set. Cardinality
          is soft-capped at 3; raw weights are normalised at read time.
        </p>
        <form action={replaceBindingsAction} style={{
          border: '1px solid #e5e5e5', borderRadius: 6, padding: '1rem',
          display: 'flex', flexDirection: 'column', gap: '0.75rem',
        }}>
          <input type="hidden" name="tenantId" value={tenantId} />
          <input type="hidden" name="userId" value="admin-user" />
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '0.5rem' }}>
              <select name="slug" defaultValue={bindings[i]?.domainSlug ?? ''} style={selectStyle}>
                <option value="">(none)</option>
                {slugChoices.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <select name="role" defaultValue={bindings[i]?.role ?? 'secondary'} style={selectStyle}>
                <option value="primary">primary</option>
                <option value="secondary">secondary</option>
              </select>
              <input
                name="rawWeight"
                type="number"
                step="0.01" min="0" max="1"
                defaultValue={bindings[i]?.rawWeight ?? 1}
                style={inputStyle}
              />
            </div>
          ))}
          <button type="submit" style={{
            alignSelf: 'flex-start', padding: '0.45rem 1rem',
            background: '#065f46', color: '#fff', border: 'none',
            cursor: 'pointer', fontSize: 13,
          }}>Replace bindings</button>
        </form>
      </section>
    </>
  );
}

// ── Registry tab ─────────────────────────────────────────────────────────

function RegistryTab({ entries }: { entries: DomainEntry[] }) {
  return (
    <section>
      <h3 style={{ marginBottom: '0.5rem', fontSize: 14, color: '#525252' }}>
        Canonical taxonomy ({entries.length})
      </h3>
      {entries.length === 0 && (
        <p style={{ color: '#666', fontSize: 13 }}>
          The platform domain registry is empty. This usually means the
          catalog migration hasn&rsquo;t been applied.
        </p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {entries.map((e) => (
          <div key={e.slug} style={{
            border: '1px solid #e5e5e5', borderRadius: 6,
            padding: '0.75rem 1rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem' }}>
              <span style={{ fontFamily: 'monospace', fontSize: 13 }}>{e.slug}</span>
              <span style={maturityBadge(e.maturity)}>{e.maturity.replace(/_/g, ' ')}</span>
              <span style={{ fontSize: 11, color: '#888' }}>{e.category}</span>
            </div>
            <div style={{ marginTop: 4, fontSize: 12, color: '#525252' }}>
              {e.displayName} — {e.description}
            </div>
            {(e.compliancePostures.length > 0 || e.typicalConnectors.length > 0) && (
              <div style={{ marginTop: 4, fontSize: 11, color: '#888' }}>
                {e.compliancePostures.length > 0 && (
                  <span>compliance: {e.compliancePostures.join(', ')}</span>
                )}
                {e.compliancePostures.length > 0 && e.typicalConnectors.length > 0 && (
                  <span>{' · '}</span>
                )}
                {e.typicalConnectors.length > 0 && (
                  <span>connectors: {e.typicalConnectors.join(', ')}</span>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────

const selectStyle: React.CSSProperties = {
  padding: '0.35rem',
  border: '1px solid #ccc',
  borderRadius: 4,
  fontSize: 13,
};
const inputStyle: React.CSSProperties = {
  padding: '0.35rem',
  border: '1px solid #ccc',
  borderRadius: 4,
  fontSize: 13,
};

function maturityBadge(m: DomainEntry['maturity']): React.CSSProperties {
  const colorMap: Record<DomainEntry['maturity'], string> = {
    general_availability: '#065f46',
    beta: '#1e3a8a',
    experimental: '#92400e',
    deprecated: '#991b1b',
  };
  return {
    background: colorMap[m], color: '#fff', fontSize: 10,
    padding: '2px 6px', borderRadius: 3, textTransform: 'uppercase',
  };
}
