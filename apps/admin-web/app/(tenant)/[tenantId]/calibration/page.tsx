/**
 * F.4.8 / F.4.6: calibration snapshot detail page.
 *
 *   GET /tenants/:tenantId/calibration
 *
 * Pairs with the global CalibrationBadge that ships in the layout —
 * the badge surfaces the headline score; this page surfaces the
 * supporting signals, per-action-class breakdown, and the autonomous-
 * gate state.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { pipelineApi } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Calibration' };

interface CalibrationResponse {
  tenantId: string;
  score: number;
  threshold: number;
  summary: string;
  signals: Record<string, number | boolean>;
  gateEnabled: boolean;
  meetsAutonomousThreshold: boolean;
  actionClassScores: Record<string, number>;
  snapshotAt: string;
  sourceSig: string;
}

export default async function CalibrationPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;

  let calibration: CalibrationResponse | null = null;
  let fetchError: string | null = null;
  try {
    calibration = await pipelineApi.get<CalibrationResponse>(`/tenants/${tenantId}/calibration`);
  } catch (err: unknown) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  return (
    <>
      <PageHeader
        title="Calibration"
        subtitle="Readiness signals + autonomous-mode gate state for this tenant"
      />
      {fetchError && (
        <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>
      )}
      {!calibration && !fetchError && (
        <p style={{ color: '#666', fontSize: 13 }}>
          Calibration is unavailable. New tenants pre-{`T.0`} may not have a
          snapshot yet — finish onboarding via{' '}
          <Link href={`/t/${tenantId}/onboarding`} style={{ color: '#1e3a8a' }}>
            Onboarding
          </Link>{' '}to populate the signal sources.
        </p>
      )}

      {calibration && (
        <>
          <ScoreHeader cal={calibration} />
          <SignalsBlock signals={calibration.signals} />
          <ActionClassBlock scores={calibration.actionClassScores} />
          <SigBlock at={calibration.snapshotAt} sig={calibration.sourceSig} />
        </>
      )}
    </>
  );
}

function ScoreHeader({ cal }: { cal: CalibrationResponse }) {
  const pct = (cal.score * 100).toFixed(0);
  return (
    <section style={{
      border: '1px solid #e5e5e5', borderRadius: 6,
      padding: '1rem 1.25rem', marginBottom: '1.5rem',
      display: 'grid', gridTemplateColumns: 'auto 1fr',
      columnGap: '1.5rem', alignItems: 'center',
    }}>
      <div style={{
        background: scoreColor(cal.score), color: '#fff',
        borderRadius: 8, padding: '0.75rem 1.25rem',
        fontSize: 24, fontFamily: 'monospace', fontWeight: 700,
      }}>
        {pct}<span style={{ fontSize: 14 }}>%</span>
      </div>
      <div>
        <div style={{ fontSize: 14, color: '#525252' }}>{cal.summary}</div>
        <div style={{ marginTop: 6, fontSize: 12, color: '#666' }}>
          autonomous threshold: <code>{(cal.threshold * 100).toFixed(0)}%</code>
          {' · '}gate{' '}
          <span style={{
            background: cal.gateEnabled ? '#1e3a8a' : '#525252', color: '#fff',
            fontSize: 10, padding: '1px 5px', borderRadius: 3,
          }}>{cal.gateEnabled ? 'ENABLED' : 'DISABLED'}</span>
          {cal.gateEnabled && (
            <>
              {' · '}
              <span style={{
                background: cal.meetsAutonomousThreshold ? '#065f46' : '#92400e',
                color: '#fff', fontSize: 10, padding: '1px 5px', borderRadius: 3,
              }}>
                {cal.meetsAutonomousThreshold ? 'MEETS' : 'BELOW'} THRESHOLD
              </span>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function SignalsBlock({ signals }: { signals: Record<string, number | boolean> }) {
  return (
    <section style={{ marginBottom: '1.5rem' }}>
      <h3 style={{ marginBottom: '0.5rem', fontSize: 14, color: '#525252' }}>
        Signal inputs
      </h3>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: '0.5rem',
      }}>
        {Object.entries(signals).map(([k, v]) => (
          <div key={k} style={{
            border: '1px solid #e5e5e5', borderRadius: 4,
            padding: '0.6rem 0.75rem',
          }}>
            <div style={{ fontSize: 11, color: '#888' }}>{humanize(k)}</div>
            <div style={{ marginTop: 2, fontSize: 16, fontFamily: 'monospace' }}>
              {typeof v === 'boolean' ? (v ? 'yes' : 'no') : v}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ActionClassBlock({ scores }: { scores: Record<string, number> }) {
  const entries = Object.entries(scores).sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) {
    return (
      <section style={{ marginBottom: '1.5rem' }}>
        <h3 style={{ marginBottom: '0.5rem', fontSize: 14, color: '#525252' }}>
          Per-action-class readiness
        </h3>
        <p style={{ color: '#666', fontSize: 13 }}>
          No observations yet. Class scores accumulate as actions execute —
          cold-start defaults apply via ActionTrustLadder.
        </p>
      </section>
    );
  }
  return (
    <section style={{ marginBottom: '1.5rem' }}>
      <h3 style={{ marginBottom: '0.5rem', fontSize: 14, color: '#525252' }}>
        Per-action-class readiness ({entries.length})
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        {entries.map(([cls, score]) => (
          <div key={cls} style={{
            display: 'grid', gridTemplateColumns: '1fr 60px',
            gap: '0.75rem', alignItems: 'center',
            border: '1px solid #f0f0f0', borderRadius: 4,
            padding: '0.4rem 0.75rem',
          }}>
            <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{cls}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <div style={{
                flex: 1, height: 6, background: '#f5f5f5', borderRadius: 3,
              }}>
                <div style={{
                  width: `${Math.max(0, Math.min(1, score)) * 100}%`,
                  height: '100%', background: scoreColor(score),
                  borderRadius: 3,
                }} />
              </div>
              <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#525252', minWidth: 28, textAlign: 'right' }}>
                {(score * 100).toFixed(0)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function SigBlock({ at, sig }: { at: string; sig: string }) {
  return (
    <section>
      <div style={{ fontSize: 11, color: '#888' }}>
        snapshot at {new Date(at).toLocaleString()}
        {' · '}
        signed: <code>{sig.slice(0, 12)}…</code>
      </div>
    </section>
  );
}

function humanize(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreColor(score: number): string {
  if (score >= 0.85) return '#065f46';
  if (score >= 0.60) return '#1e3a8a';
  if (score >= 0.40) return '#92400e';
  if (score >= 0.20) return '#7c2d12';
  return '#525252';
}
