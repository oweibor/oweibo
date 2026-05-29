/**
 * F.4.8 / F.4.7: tenant template catalog page.
 *
 *   GET /tenants/:tenantId/templates
 *   GET /tenants/:tenantId/templates/:slug
 *
 * Lists every active template + drills into one when ?slug= is set.
 * Each template surfaces its industries, default features, default
 * quotas, and the seed manifests the bootstrap pipeline will run.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { pipelineApi } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Templates' };

interface TenantTemplate {
  slug: string;
  displayName: string;
  description: string;
  industries: string[];
  defaultFeatures: Record<string, unknown>;
  defaultQuotas: Record<string, unknown>;
  seedMemoryTags: string[];
  seedSkillSet: string;
  goalTemplateSet: string;
  active: boolean;
}

export default async function TemplatesPage({
  params, searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ slug?: string }>;
}) {
  const { tenantId } = await params;
  const { slug: selectedSlug } = await searchParams;

  let templates: TenantTemplate[] = [];
  let detail: TenantTemplate | null = null;
  let fetchError: string | null = null;
  try {
    const res = await pipelineApi.get<{ templates: TenantTemplate[] }>(
      `/tenants/${tenantId}/templates`,
    );
    templates = res.templates ?? [];
    if (selectedSlug) {
      try {
        const det = await pipelineApi.get<{ template: TenantTemplate }>(
          `/tenants/${tenantId}/templates/${selectedSlug}`,
        );
        detail = det.template;
      } catch {
        // 404 on detail is non-fatal — fall back to list-only render.
      }
    }
  } catch (err: unknown) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  return (
    <>
      <PageHeader
        title="Templates"
        subtitle="Platform-curated catalog used at tenant-create time and by the bootstrap pipeline"
      />
      {fetchError && (
        <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.5fr', gap: '1.25rem' }}>
        <section>
          <h3 style={{ marginBottom: '0.5rem', fontSize: 14, color: '#525252' }}>
            Catalog ({templates.length})
          </h3>
          {templates.length === 0 && !fetchError && (
            <p style={{ color: '#666', fontSize: 13 }}>
              No active templates. Run the seed migration or insert rows
              into <code>oweibo.tenant_templates</code> via platform admin
              tooling.
            </p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {templates.map((t) => (
              <Link
                key={t.slug}
                href={`/t/${tenantId}/templates?slug=${t.slug}`}
                style={{
                  display: 'block', padding: '0.65rem 0.85rem',
                  border: `1px solid ${selectedSlug === t.slug ? '#1e3a8a' : '#e5e5e5'}`,
                  background: selectedSlug === t.slug ? '#f0f4ff' : '#fff',
                  borderRadius: 6, textDecoration: 'none', color: 'inherit',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 13 }}>{t.slug}</span>
                  {t.slug === 'default' && (
                    <span style={{
                      background: '#525252', color: '#fff', fontSize: 10,
                      padding: '1px 5px', borderRadius: 3,
                    }}>DEFAULT</span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: '#525252', marginTop: 2 }}>
                  {t.displayName}
                </div>
                {t.industries.length > 0 && (
                  <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                    {t.industries.join(', ')}
                  </div>
                )}
              </Link>
            ))}
          </div>
        </section>

        <section>
          <h3 style={{ marginBottom: '0.5rem', fontSize: 14, color: '#525252' }}>
            {detail ? `Detail: ${detail.slug}` : 'Detail'}
          </h3>
          {!detail && (
            <p style={{ color: '#888', fontSize: 13 }}>
              Select a template from the catalog to inspect its full
              configuration.
            </p>
          )}
          {detail && <TemplateDetail t={detail} />}
        </section>
      </div>
    </>
  );
}

function TemplateDetail({ t }: { t: TenantTemplate }) {
  return (
    <div style={{
      border: '1px solid #e5e5e5', borderRadius: 6,
      padding: '1rem 1.25rem',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem' }}>
        <span style={{ fontSize: 16, fontWeight: 600 }}>{t.displayName}</span>
        <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#888' }}>
          {t.slug}
        </span>
      </div>
      <p style={{ marginTop: 6, marginBottom: '0.75rem', fontSize: 13, color: '#525252' }}>
        {t.description}
      </p>

      <DetailRow label="Industries">
        {t.industries.length > 0 ? t.industries.join(', ') : <em style={{ color: '#888' }}>—</em>}
      </DetailRow>

      <DetailRow label="Seed memory tags">
        {t.seedMemoryTags.length > 0
          ? <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{t.seedMemoryTags.join(', ')}</span>
          : <em style={{ color: '#888' }}>none</em>}
      </DetailRow>

      <DetailRow label="Seed skill set">
        <code>{t.seedSkillSet}</code>
      </DetailRow>

      <DetailRow label="Goal template set">
        <code>{t.goalTemplateSet}</code>
      </DetailRow>

      <DetailRow label="Default features">
        <JsonBlock obj={t.defaultFeatures} />
      </DetailRow>

      <DetailRow label="Default quotas">
        <JsonBlock obj={t.defaultQuotas} />
      </DetailRow>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '140px 1fr',
      gap: '0.75rem', alignItems: 'baseline',
      padding: '0.4rem 0', borderTop: '1px solid #f5f5f5',
    }}>
      <span style={{ fontSize: 11, color: '#888', textTransform: 'uppercase' }}>
        {label}
      </span>
      <span style={{ fontSize: 13, color: '#333' }}>{children}</span>
    </div>
  );
}

function JsonBlock({ obj }: { obj: Record<string, unknown> }) {
  if (Object.keys(obj).length === 0) {
    return <em style={{ color: '#888' }}>empty</em>;
  }
  return (
    <pre style={{
      margin: 0, padding: '0.5rem', background: '#fafafa',
      border: '1px solid #f0f0f0', borderRadius: 4,
      fontSize: 11, overflowX: 'auto',
    }}>{JSON.stringify(obj, null, 2)}</pre>
  );
}
