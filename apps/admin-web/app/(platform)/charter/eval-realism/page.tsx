import type { Metadata } from 'next';
import { requireScope } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';
import { pipelineApi } from '@/lib/api';

export const metadata: Metadata = { title: 'Eval Realism' };

interface CorrelationRow {
  slotId:      string;
  computedAt:  string;
  spearmanRho: number;
  sampleSize:  number;
  flagged:     boolean;
  windowStart: string;
  windowEnd:   string;
}

function rhoColor(rho: number): string {
  if (rho >= 0.7) return '#065f46';
  if (rho >= 0.4) return '#92400e';
  return '#991b1b';
}

export default async function EvalRealismPage() {
  await requireScope('platform:charter:read');

  let rows: CorrelationRow[] = [];
  let fetchError: string | null = null;

  try {
    const result = await pipelineApi.get<{ correlations: CorrelationRow[] }>(
      '/charter/eval-realism/latest',
    );
    rows = result.correlations ?? [];
  } catch (err: unknown) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  const flaggedCount = rows.filter(r => r.flagged).length;

  return (
    <>
      <PageHeader
        title="Eval-vs-Production Correlation"
        subtitle={`§8.3.4 — Spearman ρ per slot (30-day rolling window)`}
      />

      <p style={{ color: '#555', fontSize: 14, marginBottom: '1.5rem' }}>
        Measures whether the eval suite is a useful predictor of production quality.
        ρ below 0.4 sustained ≥7 days triggers a charter alert and promotion freeze for that slot.
        This table is read-only — the GEPA optimizer never reads it.
      </p>

      {fetchError && <p style={{ color: '#c00' }}>Failed to load data: {fetchError}</p>}

      {flaggedCount > 0 && (
        <div style={{
          background: '#fef2f2', border: '1px solid #fca5a5',
          borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '1rem',
          color: '#991b1b', fontWeight: 500, fontSize: 14,
        }}>
          ⚠ {flaggedCount} slot{flaggedCount > 1 ? 's' : ''} flagged for sustained low correlation.
          Charter spot-audit required.
        </div>
      )}

      {rows.length === 0 && !fetchError && (
        <p style={{ color: '#666' }}>No correlation data yet. The daily cron hasn't run or there are no active bandit arms with eval data.</p>
      )}

      {rows.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e5e5', textAlign: 'left' }}>
              <th style={{ padding: '0.5rem 0.75rem' }}>Slot ID</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Spearman ρ</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Sample size</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Window</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Computed</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={`${r.slotId}-${r.computedAt}`} style={{
                borderBottom: '1px solid #f0f0f0',
                background:   r.flagged ? '#fef2f2' : undefined,
              }}>
                <td style={{ padding: '0.5rem 0.75rem', fontFamily: 'monospace', fontSize: 12 }}>
                  {r.slotId}
                </td>
                <td style={{ padding: '0.5rem 0.75rem', fontWeight: 700, color: rhoColor(r.spearmanRho) }}>
                  {r.spearmanRho.toFixed(4)}
                </td>
                <td style={{ padding: '0.5rem 0.75rem', color: '#666' }}>
                  {r.sampleSize}
                </td>
                <td style={{ padding: '0.5rem 0.75rem', fontSize: 12, color: '#666' }}>
                  {new Date(r.windowStart).toLocaleDateString()} –{' '}
                  {new Date(r.windowEnd).toLocaleDateString()}
                </td>
                <td style={{ padding: '0.5rem 0.75rem', fontSize: 12, color: '#666' }}>
                  {new Date(r.computedAt).toLocaleString()}
                </td>
                <td style={{ padding: '0.5rem 0.75rem' }}>
                  {r.flagged ? (
                    <span style={{ color: '#991b1b', fontWeight: 600 }}>⚠ flagged</span>
                  ) : r.spearmanRho >= 0.7 ? (
                    <span style={{ color: '#065f46' }}>strong</span>
                  ) : r.spearmanRho >= 0.4 ? (
                    <span style={{ color: '#92400e' }}>moderate</span>
                  ) : (
                    <span style={{ color: '#991b1b' }}>low</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <details style={{ marginTop: '2rem' }}>
        <summary style={{ fontSize: 13, color: '#555', cursor: 'pointer' }}>Interpretation guide</summary>
        <div style={{ fontSize: 13, color: '#555', lineHeight: 1.6, marginTop: '0.75rem', paddingLeft: '1rem' }}>
          <p><strong>ρ ≥ 0.7 (strong):</strong> Eval suite is a good predictor of production outcomes for this slot. No action needed.</p>
          <p><strong>0.4 ≤ ρ &lt; 0.7 (moderate):</strong> Eval has some predictive value but watch for decline over multiple days.</p>
          <p><strong>ρ &lt; 0.4 (low):</strong> Eval suite is barely better than random for predicting production quality. Investigate — the optimiser may be gaming the eval.</p>
          <p><strong>Flagged:</strong> ρ &lt; 0.4 sustained ≥7 consecutive days. Promotions for this slot are frozen pending charter review.</p>
          <p style={{ marginTop: '0.5rem', color: '#888' }}>Reference: §8.3.4. Sustained ρ &lt; 0.4 for ≥30 days on ≥3 slots triggers RT-001 (Shadow Replay) reactivation criteria.</p>
        </div>
      </details>
    </>
  );
}
