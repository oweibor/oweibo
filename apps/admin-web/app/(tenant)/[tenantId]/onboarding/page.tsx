import type { Metadata } from 'next';
import { identityApi } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Onboarding' };

interface StepRow {
  name: string;
  status: 'pending' | 'running' | 'ok' | 'skipped' | 'failed';
  attempts: number;
  lastError: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

interface BootstrapResponse {
  state: 'absent' | 'pending' | 'running' | 'ready' | 'failed' | 'disabled';
  templateSlug?: string;
  attempts?: number;
  lastError?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  progress?: { done: number; total: number; failed: number };
  steps?: StepRow[];
}

const STATE_COLOR: Record<string, string> = {
  ready: '#065f46',
  running: '#1e3a8a',
  pending: '#525252',
  failed: '#991b1b',
  disabled: '#525252',
  absent: '#525252',
};

const STEP_COLOR: Record<StepRow['status'], string> = {
  ok: '#065f46',
  skipped: '#525252',
  failed: '#991b1b',
  running: '#1e3a8a',
  pending: '#525252',
};

export default async function OnboardingPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;

  let bootstrap: BootstrapResponse | null = null;
  let fetchError: string | null = null;
  try {
    bootstrap = await identityApi.get<BootstrapResponse>(`/api/v1/tenants/${tenantId}/bootstrap`);
  } catch (err: any) {
    fetchError = err.message;
  }

  const state = bootstrap?.state ?? 'absent';
  const stateColor = STATE_COLOR[state] ?? '#333';
  const progress = bootstrap?.progress;
  const steps = bootstrap?.steps ?? [];

  return (
    <>
      <PageHeader
        title="Onboarding"
        subtitle={state === 'absent'
          ? 'This tenant predates the bootstrap pipeline. Run the backfill script to opt in to platform seed content.'
          : `${progress?.done ?? 0} / ${progress?.total ?? 0} step${(progress?.total ?? 0) !== 1 ? 's' : ''} complete`
        }
      />
      {fetchError && <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>}

      {bootstrap && state !== 'absent' && (
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '1rem' }}>
          <span style={{
            background: stateColor, color: '#fff', fontSize: 11,
            padding: '2px 10px', borderRadius: 3, textTransform: 'uppercase', letterSpacing: 0.5,
          }}>{state}</span>
          {bootstrap.templateSlug && (
            <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#666' }}>
              template: {bootstrap.templateSlug}
            </span>
          )}
          {progress?.failed && progress.failed > 0 ? (
            <span style={{ color: '#991b1b', fontSize: 13 }}>
              {progress.failed} failed step{progress.failed !== 1 ? 's' : ''}
            </span>
          ) : null}
        </div>
      )}

      {state === 'running' && (
        <p style={{
          color: '#1e3a8a', background: '#dbeafe', padding: '0.5rem 1rem',
          borderRadius: 4, marginBottom: '1rem', fontSize: 13,
        }}>
          The system is finishing setup. Some features may be limited until every step completes.
        </p>
      )}
      {state === 'failed' && bootstrap?.lastError && (
        <p style={{
          color: '#991b1b', background: '#fee2e2', padding: '0.5rem 1rem',
          borderRadius: 4, marginBottom: '1rem', fontSize: 13,
        }}>
          Last error: {bootstrap.lastError}
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {steps.map((s) => (
          <div key={s.name} style={{
            display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '0.75rem',
            border: '1px solid #eee', borderRadius: 4, padding: '0.5rem 0.75rem', alignItems: 'center',
          }}>
            <span style={{ fontFamily: 'monospace', fontSize: 13 }}>{s.name}</span>
            <span style={{
              background: STEP_COLOR[s.status], color: '#fff', fontSize: 10,
              padding: '2px 6px', borderRadius: 3,
            }}>{s.status}</span>
            <span style={{ fontSize: 11, color: '#888' }}>
              attempts: {s.attempts}
              {s.lastError && ` · ${s.lastError.slice(0, 50)}${s.lastError.length > 50 ? '…' : ''}`}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
