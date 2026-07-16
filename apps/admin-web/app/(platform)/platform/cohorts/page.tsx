import type { Metadata } from 'next';
import { requireScope } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';
import { pipelineApi } from '@/lib/api';
import { TenantCohortControls } from './TenantCohortControls';

export const metadata: Metadata = { title: 'Cohort Channels' };

export interface TenantCohortRow {
  tenantId:         string;
  name:             string | null;
  cohortChannel:    string;
  lastChangedAt:    string | null;
  lastChangedBy:    string | null;
  lastChangeReason: string | null;
}

interface ChangeRecord {
  id:              string;
  tenantId:        string;
  previousChannel: string;
  newChannel:      string;
  reason:          string;
  changedBy:       string;
  changedAt:       string;
}

const CHANNEL_STYLES: Record<string, { bg: string; text: string; border: string }> = {
  'stable-v0':            { bg: '#f3f4f6', text: '#374151', border: '#d1d5db' },
  'stable':               { bg: '#ecfdf5', text: '#065f46', border: '#86efac' },
  'beta':                 { bg: '#fef3c7', text: '#92400e', border: '#fcd34d' },
  'fast':                 { bg: '#fee2e2', text: '#991b1b', border: '#fca5a5' },
  'pending_human_review': { bg: '#e0e7ff', text: '#3730a3', border: '#a5b4fc' },
};

export default async function CohortsPage() {
  await requireScope('platform:admin');

  let tenants:    TenantCohortRow[] = [];
  let channels:   string[]          = [];
  let recent:     ChangeRecord[]    = [];
  let fetchError: string | null     = null;

  try {
    const [t, c, r] = await Promise.all([
      pipelineApi.get<{ tenants: TenantCohortRow[] }>('/platform/cohorts/tenants'),
      pipelineApi.get<{ channels: string[] }>('/platform/cohorts/channels'),
      pipelineApi.get<{ recent: ChangeRecord[] }>('/platform/cohorts/recent?limit=20'),
    ]);
    tenants  = t.tenants  ?? [];
    channels = c.channels ?? ['stable-v0'];
    recent   = r.recent   ?? [];
  } catch (err: unknown) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  // Aggregate: tenants per cohort, for the summary strip
  const byChannel = new Map<string, number>();
  for (const t of tenants) {
    byChannel.set(t.cohortChannel, (byChannel.get(t.cohortChannel) ?? 0) + 1);
  }

  return (
    <>
      <PageHeader
        title="Cohort Channels"
        subtitle="§9.2 — per-tenant cohort_channel routing (stable-v0 / stable / beta / fast)"
      />

      <p style={{ color: '#555', fontSize: 14, marginBottom: '1.25rem' }}>
        Every task started by a tenant uses the prompt set bound to that tenant&apos;s cohort channel.
        <strong> stable-v0</strong> is the static baseline; <strong>stable</strong> is the GA channel;
        <strong> beta</strong> and <strong>fast</strong> are progressively earlier rollouts of GEPA-produced
        candidates. Changing a tenant&apos;s cohort takes effect on the next task — in-flight tasks
        remain pinned to their original prompts.
      </p>

      {fetchError && (
        <p style={{ color: '#c00', marginBottom: '1rem' }}>
          Failed to load cohort data: {fetchError}
        </p>
      )}

      {/* Summary strip */}
      {tenants.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1.25rem' }}>
          {Array.from(byChannel.entries()).map(([channel, count]) => {
            const style = CHANNEL_STYLES[channel] ?? CHANNEL_STYLES['stable-v0']!;
            return (
              <div key={channel} style={{
                padding: '0.4rem 0.75rem', fontSize: 13, fontWeight: 500,
                background: style.bg, color: style.text, border: `1px solid ${style.border}`,
                borderRadius: 4,
              }}>
                {channel}: <strong>{count}</strong> tenant{count === 1 ? '' : 's'}
              </div>
            );
          })}
        </div>
      )}

      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: '0.75rem' }}>
        Tenants ({tenants.length})
      </h2>

      {tenants.length === 0 ? (
        <div style={{
          padding: '1.25rem', background: '#f9fafb', border: '1px solid #e5e7eb',
          borderRadius: 6, color: '#666', fontSize: 14, marginBottom: '2rem',
        }}>
          No tenants found.
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: '2rem' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e5e5', textAlign: 'left' }}>
              <th style={{ padding: '0.5rem 0.75rem' }}>Tenant</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Current cohort</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Last change</th>
              <th style={{ padding: '0.5rem 0.75rem', width: 320 }}>Change cohort</th>
            </tr>
          </thead>
          <tbody>
            {tenants.map(t => {
              const style = CHANNEL_STYLES[t.cohortChannel] ?? CHANNEL_STYLES['stable-v0']!;
              return (
                <tr key={t.tenantId} style={{ borderBottom: '1px solid #f0f0f0', verticalAlign: 'top' }}>
                  <td style={{ padding: '0.6rem 0.75rem' }}>
                    <div style={{ fontWeight: 500 }}>{t.name ?? '(unnamed)'}</div>
                    <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#888', marginTop: '0.2rem' }}>
                      {t.tenantId}
                    </div>
                  </td>
                  <td style={{ padding: '0.6rem 0.75rem' }}>
                    <span style={{
                      display: 'inline-block', padding: '0.2rem 0.6rem', fontSize: 12, fontWeight: 600,
                      background: style.bg, color: style.text, border: `1px solid ${style.border}`,
                      borderRadius: 4,
                    }}>
                      {t.cohortChannel}
                    </span>
                  </td>
                  <td style={{ padding: '0.6rem 0.75rem', fontSize: 12, color: '#666' }}>
                    {t.lastChangedAt
                      ? (
                          <>
                            {new Date(t.lastChangedAt).toLocaleDateString()}
                            <div style={{ fontSize: 11, color: '#888' }}>by {t.lastChangedBy}</div>
                            {t.lastChangeReason && (
                              <div style={{ fontSize: 11, color: '#888', marginTop: '0.2rem', maxWidth: 200 }}>
                                {t.lastChangeReason}
                              </div>
                            )}
                          </>
                        )
                      : <span style={{ color: '#999' }}>never</span>}
                  </td>
                  <td style={{ padding: '0.6rem 0.75rem' }}>
                    <TenantCohortControls
                      tenantId={t.tenantId}
                      currentChannel={t.cohortChannel}
                      availableChannels={channels}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: '0.75rem' }}>
        Recent changes
      </h2>

      {recent.length === 0 ? (
        <p style={{ color: '#666', fontSize: 14 }}>No cohort changes recorded yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e5e5', textAlign: 'left' }}>
              <th style={{ padding: '0.4rem 0.75rem' }}>When</th>
              <th style={{ padding: '0.4rem 0.75rem' }}>Tenant</th>
              <th style={{ padding: '0.4rem 0.75rem' }}>Transition</th>
              <th style={{ padding: '0.4rem 0.75rem' }}>By</th>
              <th style={{ padding: '0.4rem 0.75rem' }}>Reason</th>
            </tr>
          </thead>
          <tbody>
            {recent.map(r => (
              <tr key={r.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={{ padding: '0.4rem 0.75rem', color: '#666' }}>
                  {new Date(r.changedAt).toLocaleString()}
                </td>
                <td style={{ padding: '0.4rem 0.75rem', fontFamily: 'monospace', fontSize: 11 }}>
                  {r.tenantId.slice(0, 8)}…
                </td>
                <td style={{ padding: '0.4rem 0.75rem', fontWeight: 600, fontSize: 12 }}>
                  {r.previousChannel} → {r.newChannel}
                </td>
                <td style={{ padding: '0.4rem 0.75rem', color: '#555' }}>{r.changedBy}</td>
                <td style={{ padding: '0.4rem 0.75rem', color: '#555' }}>{r.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
