import type { Metadata } from 'next';
import { identityApi } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Tenant templates' };

interface TenantTemplate {
  slug: string;
  displayName: string;
  description: string;
  industries: string[];
  seedMemoryTags: string[];
  seedSkillSet: string;
  goalTemplateSet: string;
  active: boolean;
}

export default async function TemplatesPage() {
  let templates: TenantTemplate[] = [];
  let fetchError: string | null = null;
  try {
    const result = await identityApi.get<{ templates: TenantTemplate[] }>('/api/v1/platform/templates');
    templates = result.templates ?? [];
  } catch (err: any) {
    fetchError = err.message;
  }

  // 'default' first, then alphabetical — matches the registry's ordering.
  const sorted = [...templates].sort((a, b) => {
    if (a.slug === 'default') return -1;
    if (b.slug === 'default') return 1;
    return a.slug.localeCompare(b.slug);
  });

  return (
    <>
      <PageHeader
        title="Tenant templates"
        subtitle={`${sorted.length} active template${sorted.length !== 1 ? 's' : ''}`}
      />
      {fetchError && <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>}
      {sorted.length === 0 && !fetchError && (
        <p style={{ color: '#666', fontSize: 14 }}>
          No templates defined. The 'default' template is seeded by the
          T.6 migration; if missing, check that the migration ran.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {sorted.map((t) => (
          <div key={t.slug} style={{
            border: '1px solid #e5e5e5', borderRadius: 6, padding: '0.85rem 1rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', marginBottom: 4 }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>{t.displayName}</span>
              <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#666' }}>{t.slug}</span>
              {t.slug === 'default' && (
                <span style={{
                  background: '#374151', color: '#fff', fontSize: 10,
                  padding: '1px 6px', borderRadius: 3,
                }}>default</span>
              )}
            </div>
            <p style={{ fontSize: 13, color: '#444', margin: '0 0 0.5rem 0' }}>{t.description}</p>
            <div style={{ display: 'flex', gap: '1rem', fontSize: 11, color: '#888', flexWrap: 'wrap' }}>
              {t.industries.length > 0 && (
                <span>industries: {t.industries.join(', ')}</span>
              )}
              {t.seedMemoryTags.length > 0 && (
                <span>seed tags: {t.seedMemoryTags.join(', ')}</span>
              )}
              <span>skill set: {t.seedSkillSet}</span>
              <span>goal templates: {t.goalTemplateSet}</span>
            </div>
          </div>
        ))}
      </div>

      <p style={{ marginTop: '1.5rem', fontSize: 12, color: '#666' }}>
        Templates are read-only from this UI. Add or edit via SQL against
        <code style={{ margin: '0 0.3rem' }}>oweibo.tenant_templates</code>
        — a write form lands in a follow-up phase.
      </p>
    </>
  );
}
