import type { Metadata } from 'next';
import { requireScope } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';
import { pipelineApi } from '@/lib/api';
import { ThresholdControls } from './ThresholdControls';

export const metadata: Metadata = { title: 'Identity Drift Thresholds' };

interface ThresholdConfig {
  threshold_7d:    number;
  threshold_30d:   number;
  threshold_90d:   number;
  threshold_vs_v0: number;
  updated_by:      string;
  updated_at:      string;
  notes:           string | null;
}

interface DriftEvent {
  id:               string;
  detected_at:      string;
  drift_axis:       string;
  drift_magnitude:  number;
  acknowledged_at:  string | null;
  acknowledged_by:  string | null;
}

const DEFAULTS: ThresholdConfig = {
  threshold_7d:    0.15,
  threshold_30d:   0.20,
  threshold_90d:   0.25,
  threshold_vs_v0: 0.35,
  updated_by:      'default',
  updated_at:      new Date().toISOString(),
  notes:           null,
};

const WINDOW_LABELS: Record<string, string> = {
  threshold_7d:    '7-day rolling',
  threshold_30d:   '30-day rolling',
  threshold_90d:   '90-day rolling',
  threshold_vs_v0: 'vs stable-v0',
};

const WINDOW_PURPOSE: Record<string, string> = {
  threshold_7d:    'Sudden shifts within the same release',
  threshold_30d:   'Medium-term drift across multiple promotions',
  threshold_90d:   'Slow ecosystem drift (primary audit concern)',
  threshold_vs_v0: 'Total drift since platform initial state',
};

export default async function ThresholdsPage() {
  await requireScope('platform:charter:read');

  let config:     ThresholdConfig | null = null;
  let events:     DriftEvent[] = [];
  let fetchError: string | null = null;

  try {
    const result = await pipelineApi.get<{
      config: ThresholdConfig;
      recentEvents: DriftEvent[];
    }>('/platform/charter/thresholds');
    config = result.config;
    events = result.recentEvents ?? [];
  } catch {
    // Backend route not yet implemented — fall back to documented defaults
    config = DEFAULTS;
  }

  const cfg = config ?? DEFAULTS;
  const openEvents = events.filter(e => !e.acknowledged_at);

  return (
    <>
      <PageHeader
        title="Identity Drift Thresholds"
        subtitle="§18.8.3 — charter-mutable drift detection configuration"
      />

      <p style={{ color: '#555', fontSize: 14, marginBottom: '1.5rem' }}>
        Controls when the identity-fingerprinter fires a drift alert. Each axis compares the
        current fingerprint against rolling baselines; a drift event is raised when
        the delta exceeds the configured threshold <strong>and</strong> the change is
        statistically significant (CIs do not overlap). Changes are audit-logged.
      </p>

      {fetchError && (
        <p style={{ color: '#c00', marginBottom: '1rem' }}>
          Failed to load from backend: {fetchError} — showing defaults.
        </p>
      )}

      {openEvents.length > 0 && (
        <div style={{
          background: '#fef2f2', border: '1px solid #fca5a5',
          borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '1rem',
          color: '#991b1b', fontWeight: 500, fontSize: 14,
        }}>
          {openEvents.length} open drift event{openEvents.length > 1 ? 's' : ''} — charter spot-audit required.
        </div>
      )}

      {/* Threshold reference table */}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, marginBottom: '2rem' }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #e5e5e5', textAlign: 'left' }}>
            <th style={{ padding: '0.5rem 0.75rem' }}>Window</th>
            <th style={{ padding: '0.5rem 0.75rem' }}>Threshold</th>
            <th style={{ padding: '0.5rem 0.75rem' }}>Purpose</th>
          </tr>
        </thead>
        <tbody>
          {(['threshold_7d', 'threshold_30d', 'threshold_90d', 'threshold_vs_v0'] as const).map(key => (
            <tr key={key} style={{ borderBottom: '1px solid #f0f0f0' }}>
              <td style={{ padding: '0.5rem 0.75rem', fontWeight: 600 }}>
                {WINDOW_LABELS[key] ?? key}
              </td>
              <td style={{ padding: '0.5rem 0.75rem', fontFamily: 'monospace' }}>
                &gt; {cfg[key].toFixed(2)}
              </td>
              <td style={{ padding: '0.5rem 0.75rem', fontSize: 13, color: '#555' }}>
                {WINDOW_PURPOSE[key] ?? ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ fontSize: 12, color: '#888', marginBottom: '2rem' }}>
        Last updated by <strong>{cfg.updated_by}</strong> at {new Date(cfg.updated_at).toLocaleString()}
        {cfg.notes && <> — {cfg.notes}</>}
      </div>

      {/* Update form (client component, platform:admin only) */}
      <ThresholdControls currentConfig={cfg} />

      {/* Recent drift events */}
      {events.length > 0 && (
        <>
          <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: '0.75rem' }}>Recent drift events</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #e5e5e5', textAlign: 'left' }}>
                <th style={{ padding: '0.4rem 0.75rem' }}>Detected</th>
                <th style={{ padding: '0.4rem 0.75rem' }}>Axis</th>
                <th style={{ padding: '0.4rem 0.75rem' }}>Magnitude</th>
                <th style={{ padding: '0.4rem 0.75rem' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {events.slice(0, 20).map(e => (
                <tr key={e.id} style={{
                  borderBottom: '1px solid #f0f0f0',
                  background: !e.acknowledged_at ? '#fef2f2' : undefined,
                }}>
                  <td style={{ padding: '0.4rem 0.75rem', color: '#666' }}>
                    {new Date(e.detected_at).toLocaleString()}
                  </td>
                  <td style={{ padding: '0.4rem 0.75rem', fontFamily: 'monospace', fontSize: 12 }}>
                    {e.drift_axis}
                  </td>
                  <td style={{ padding: '0.4rem 0.75rem', fontWeight: 600, color: '#991b1b' }}>
                    {e.drift_magnitude.toFixed(4)}
                  </td>
                  <td style={{ padding: '0.4rem 0.75rem' }}>
                    {e.acknowledged_at ? (
                      <span style={{ color: '#065f46', fontSize: 12 }}>
                        Acknowledged by {e.acknowledged_by ?? '?'} at {new Date(e.acknowledged_at).toLocaleDateString()}
                      </span>
                    ) : (
                      <span style={{ color: '#991b1b', fontWeight: 600 }}>Open</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {events.length === 0 && !fetchError && (
        <p style={{ color: '#666', fontSize: 13 }}>No drift events recorded yet.</p>
      )}

      <details style={{ marginTop: '2rem' }}>
        <summary style={{ fontSize: 13, color: '#555', cursor: 'pointer' }}>How thresholds work</summary>
        <div style={{ fontSize: 13, color: '#555', lineHeight: 1.6, marginTop: '0.75rem', paddingLeft: '1rem' }}>
          <p>The identity fingerprinter (§18.8) runs weekly and on every stable promotion.
          It computes a multi-axis fingerprint (verbosity, conservatism, hallucination tolerance,
          escalation tendency, refusal rate, planning depth, coordination overhead) and compares
          it against four rolling baselines.</p>
          <p>A drift event fires when <strong>any axis</strong> moves beyond the configured
          threshold AND the change is statistically significant (95% CI non-overlap).
          Events page the platform on-call and auto-open a spot-audit ticket in the §18
          charter queue.</p>
          <p style={{ color: '#888' }}>
            Changes to thresholds require platform:admin scope and are audit-logged with reason.
            Threshold changes are a charter-governed decision — record the reason carefully.
          </p>
        </div>
      </details>
    </>
  );
}
