/**
 * F.4.8 / F.4.5: domain depth metrics page.
 *
 *   GET /tenants/:tenantId/domains/depth
 *
 * Renders the most-recent snapshot per domain — composite score, the
 * five coverage axes (ontology / eval / compliance / connector / SME),
 * and the cron's recommended tier promotion / demotion suggestion.
 */
import type { Metadata } from 'next';
import { pipelineApi } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Domain depth' };

type RecommendedTier = 'experimental' | 'beta' | 'general_availability' | 'deprecated';

interface DepthSnapshot {
  domainSlug: string;
  snapshotAt: string;
  compositeScore: number;
  recommendedTier: RecommendedTier;
  ontologyCoverage: Record<string, unknown>;
  evalCoverage: Record<string, unknown>;
  complianceCoverage: Record<string, unknown>;
  connectorCoverage: Record<string, unknown>;
  smeCoverage: Record<string, unknown>;
}

export default async function DomainDepthPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;

  let snapshots: DepthSnapshot[] = [];
  let fetchError: string | null = null;
  try {
    const res = await pipelineApi.get<{ snapshots: DepthSnapshot[] }>(
      `/tenants/${tenantId}/domains/depth`,
    );
    snapshots = res.snapshots ?? [];
  } catch (err: unknown) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  snapshots = [...snapshots].sort((a, b) => b.compositeScore - a.compositeScore);

  return (
    <>
      <PageHeader
        title="Domain depth"
        subtitle="Composite readiness score per domain, computed across five coverage axes"
      />
      {fetchError && (
        <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>
      )}
      {snapshots.length === 0 && !fetchError && (
        <p style={{ color: '#666', fontSize: 13 }}>
          No depth snapshots yet. The cron writes one row per domain per tick —
          give the scheduler time to run, or trigger a manual recompute via
          the platform admin tooling.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {snapshots.map((s) => (
          <DepthCard key={s.domainSlug} snapshot={s} />
        ))}
      </div>
    </>
  );
}

function DepthCard({ snapshot }: { snapshot: DepthSnapshot }) {
  const scoreColor = scoreToColor(snapshot.compositeScore);
  return (
    <div style={{
      border: '1px solid #e5e5e5', borderRadius: 6,
      padding: '0.85rem 1rem',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem' }}>
        <span style={{ fontFamily: 'monospace', fontSize: 14 }}>
          {snapshot.domainSlug}
        </span>
        <span style={{
          background: scoreColor, color: '#fff', fontSize: 11,
          padding: '2px 8px', borderRadius: 3, fontWeight: 600,
        }}>
          {snapshot.compositeScore.toFixed(1)}
        </span>
        <span style={tierBadge(snapshot.recommendedTier)}>
          rec: {snapshot.recommendedTier.replace(/_/g, ' ')}
        </span>
        <span style={{ fontSize: 11, color: '#888', marginLeft: 'auto' }}>
          {new Date(snapshot.snapshotAt).toLocaleString()}
        </span>
      </div>

      <div style={{
        marginTop: 10, display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: '0.5rem',
      }}>
        <CoverageBlock label="Ontology" obj={snapshot.ontologyCoverage} />
        <CoverageBlock label="Eval"     obj={snapshot.evalCoverage} />
        <CoverageBlock label="Compliance" obj={snapshot.complianceCoverage} />
        <CoverageBlock label="Connector" obj={snapshot.connectorCoverage} />
        <CoverageBlock label="SME"      obj={snapshot.smeCoverage} />
      </div>
    </div>
  );
}

function CoverageBlock({ label, obj }: { label: string; obj: Record<string, unknown> }) {
  const entries = Object.entries(obj);
  return (
    <div style={{
      border: '1px solid #f0f0f0', borderRadius: 4,
      padding: '0.5rem 0.6rem',
    }}>
      <div style={{ fontSize: 11, color: '#525252', fontWeight: 600 }}>{label}</div>
      {entries.length === 0 && (
        <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>—</div>
      )}
      {entries.slice(0, 4).map(([k, v]) => (
        <div key={k} style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
          <span style={{ color: '#888' }}>{k}:</span>{' '}
          <span style={{ fontFamily: 'monospace' }}>{formatValue(v)}</span>
        </div>
      ))}
      {entries.length > 4 && (
        <div style={{ fontSize: 10, color: '#aaa', marginTop: 2 }}>
          (+{entries.length - 4} more)
        </div>
      )}
    </div>
  );
}

function formatValue(v: unknown): string {
  if (typeof v === 'number') return v.toFixed(2);
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return v.length > 24 ? v.slice(0, 24) + '…' : v;
  // F.7 review: JSON.stringify returns undefined for `undefined`,
  // functions, and symbols. Guard before .slice().
  const s = JSON.stringify(v);
  return (s ?? '[unrepresentable]').slice(0, 28);
}

function scoreToColor(score: number): string {
  if (score >= 80) return '#065f46';
  if (score >= 60) return '#1e3a8a';
  if (score >= 40) return '#92400e';
  if (score >= 20) return '#7c2d12';
  return '#525252';
}

function tierBadge(tier: RecommendedTier): React.CSSProperties {
  const colorMap: Record<RecommendedTier, string> = {
    general_availability: '#065f46',
    beta: '#1e3a8a',
    experimental: '#92400e',
    deprecated: '#991b1b',
  };
  return {
    background: colorMap[tier], color: '#fff', fontSize: 10,
    padding: '2px 6px', borderRadius: 3, textTransform: 'uppercase',
  };
}
