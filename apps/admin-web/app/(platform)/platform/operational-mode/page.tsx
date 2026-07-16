import type { Metadata } from 'next';
import { requireScope } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';
import { pipelineApi } from '@/lib/api';
import { OperationalModeControls } from './OperationalModeControls';

export const metadata: Metadata = { title: 'Operational Mode' };

export interface ModeState {
  currentMode: number;
  setBy:       string;
  setAt:       string;
  reason:      string;
  autoTrigger: string | null;
}

export interface ModeTransition {
  id:          string;
  fromMode:    number;
  toMode:      number;
  setBy:       string;
  setAt:       string;
  reason:      string;
  autoTrigger: string | null;
}

const MODE_NAMES: Record<number, string> = {
  5: 'Full operation',
  4: 'Eval-only',
  3: 'No bandit learning',
  2: 'No GEPA mutations',
  1: 'No promotions',
  0: 'Full freeze (stable-v0 only)',
};

const MODE_COLORS: Record<number, { bg: string; text: string; border: string }> = {
  5: { bg: '#d1fae5', text: '#065f46', border: '#6ee7b7' },
  4: { bg: '#dbeafe', text: '#1e3a8a', border: '#93c5fd' },
  3: { bg: '#fef3c7', text: '#92400e', border: '#fcd34d' },
  2: { bg: '#fed7aa', text: '#9a3412', border: '#fdba74' },
  1: { bg: '#fee2e2', text: '#991b1b', border: '#fca5a5' },
  0: { bg: '#1f2937', text: '#f9fafb', border: '#374151' },
};

export default async function OperationalModePage() {
  await requireScope('platform:admin');

  let state:       ModeState | null = null;
  let history:     ModeTransition[] = [];
  let fetchError:  string | null = null;

  try {
    const result = await pipelineApi.get<{ state: ModeState; history: ModeTransition[] }>(
      '/platform/operational-mode',
    );
    state   = result.state;
    history = result.history ?? [];
  } catch (err: unknown) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  const mode    = state?.currentMode ?? 5;
  const colors  = MODE_COLORS[mode] ?? MODE_COLORS[5]!;
  const modeName = MODE_NAMES[mode] ?? 'Unknown';

  return (
    <>
      <PageHeader
        title="Platform Operational Mode"
        subtitle="§17.5.1 — Postgres-enforced state machine"
      />

      <p style={{ color: '#555', fontSize: 14, marginBottom: '1.5rem' }}>
        Controls which adaptive loops are active. Lowering the mode is immediate and affects all pods
        within ≤30 seconds (cache TTL). <strong>Recovery from mode ≤ 1 is human-only</strong> —
        no automatic promotion. Only platform-admin users can change the mode.
      </p>

      {fetchError && (
        <p style={{ color: '#c00', marginBottom: '1rem' }}>
          Failed to load mode state: {fetchError}
        </p>
      )}

      {/* Current mode banner */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '1rem',
        padding: '1rem 1.25rem',
        background:   colors.bg,
        color:        colors.text,
        border:       `2px solid ${colors.border}`,
        borderRadius: 8,
        marginBottom: '1.5rem',
      }}>
        <div style={{ fontSize: 32, fontWeight: 700, lineHeight: 1 }}>{mode}</div>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{modeName}</div>
          {state && (
            <div style={{ fontSize: 13, opacity: 0.8, marginTop: '0.2rem' }}>
              Set by <strong>{state.setBy}</strong> at {new Date(state.setAt).toLocaleString()}
              {state.autoTrigger ? ` (auto-trigger: ${state.autoTrigger})` : ''}
            </div>
          )}
          {state?.reason && (
            <div style={{ fontSize: 13, marginTop: '0.2rem', opacity: 0.9 }}>
              Reason: {state.reason}
            </div>
          )}
        </div>
      </div>

      {/* Mode table */}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, marginBottom: '2rem' }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #e5e5e5', textAlign: 'left' }}>
            <th style={{ padding: '0.5rem 0.75rem', width: 60 }}>Mode</th>
            <th style={{ padding: '0.5rem 0.75rem' }}>Name</th>
            <th style={{ padding: '0.5rem 0.75rem' }}>What stops</th>
          </tr>
        </thead>
        <tbody>
          {([5, 4, 3, 2, 1, 0] as const).map(m => {
            const c = MODE_COLORS[m]!;
            const isCurrent = m === mode;
            return (
              <tr key={m} style={{
                borderBottom: '1px solid #f0f0f0',
                background: isCurrent ? c.bg : undefined,
                fontWeight: isCurrent ? 700 : 400,
              }}>
                <td style={{ padding: '0.5rem 0.75rem', color: isCurrent ? c.text : '#333' }}>{m}</td>
                <td style={{ padding: '0.5rem 0.75rem', color: isCurrent ? c.text : '#333' }}>{MODE_NAMES[m]}</td>
                <td style={{ padding: '0.5rem 0.75rem', fontSize: 13, color: isCurrent ? c.text : '#555' }}>
                  {m === 5 && 'Nothing — all loops live'}
                  {m === 4 && 'GEPA mutation generation'}
                  {m === 3 && 'Bandit reward updates (routing still active)'}
                  {m === 2 && 'All GEPA activity (evals + mutations); eval cache reads only'}
                  {m === 1 && 'Channel promotions; channel pointers frozen'}
                  {m === 0 && 'Everything — CohortRouter returns stable-v0 for all roles'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Mode change controls (client component) */}
      <OperationalModeControls currentMode={mode} modeNames={MODE_NAMES} />

      {/* Transition history */}
      {history.length > 0 && (
        <>
          <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: '0.75rem' }}>Transition history</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #e5e5e5', textAlign: 'left' }}>
                <th style={{ padding: '0.4rem 0.75rem' }}>When</th>
                <th style={{ padding: '0.4rem 0.75rem' }}>Transition</th>
                <th style={{ padding: '0.4rem 0.75rem' }}>By</th>
                <th style={{ padding: '0.4rem 0.75rem' }}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {history.map(t => (
                <tr key={t.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={{ padding: '0.4rem 0.75rem', color: '#666' }}>
                    {new Date(t.setAt).toLocaleString()}
                  </td>
                  <td style={{ padding: '0.4rem 0.75rem', fontWeight: 600 }}>
                    {t.fromMode} → {t.toMode}
                    {t.autoTrigger && (
                      <span style={{ fontWeight: 400, fontSize: 11, color: '#c00', marginLeft: '0.4rem' }}>
                        [auto: {t.autoTrigger}]
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '0.4rem 0.75rem', color: '#555' }}>{t.setBy}</td>
                  <td style={{ padding: '0.4rem 0.75rem', color: '#555' }}>{t.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
