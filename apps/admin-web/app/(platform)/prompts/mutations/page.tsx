import type { Metadata } from 'next';
import { requireScope } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';
import { pipelineApi } from '@/lib/api';
import { MutationFilters, MutationStatusControls } from './MutationStatusControls';

export const metadata: Metadata = { title: 'Slot Mutation Governance' };

export type MutationStatus = 'mutable' | 'guarded' | 'frozen';

export interface SlotRow {
  slotId:         string;
  role:           string;
  mutationStatus: MutationStatus;
  freezeReason:   string | null;
  lastChangedAt:  string | null;
  lastChangedBy:  string | null;
  lastRfcUrl:     string | null;
}

const STATUS_STYLES: Record<MutationStatus, { bg: string; text: string; border: string; icon: string; label: string }> = {
  mutable: { bg: '#ecfdf5', text: '#065f46', border: '#86efac', icon: '✓', label: 'mutable' },
  guarded: { bg: '#fef3c7', text: '#92400e', border: '#fcd34d', icon: '🛡', label: 'guarded' },
  frozen:  { bg: '#e0e7ff', text: '#3730a3', border: '#a5b4fc', icon: '❄', label: 'frozen'  },
};

export default async function MutationsPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string; status?: string }>;
}) {
  await requireScope('platform:admin');
  const sp = await searchParams;

  let slots:      SlotRow[]      = [];
  let fetchError: string | null  = null;

  try {
    const qs = new URLSearchParams();
    if (sp.role)   qs.set('role', sp.role);
    if (sp.status) qs.set('status', sp.status);
    const path = qs.toString()
      ? `/platform/prompts/mutations?${qs.toString()}`
      : '/platform/prompts/mutations';
    const result = await pipelineApi.get<{ slots: SlotRow[] }>(path);
    slots = result.slots ?? [];
  } catch (err: unknown) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  return (
    <>
      <PageHeader
        title="Slot Mutation Governance"
        subtitle="§7.4.3 — mutation_status policy for prompt slots (mutable / guarded / frozen)"
      />

      <p style={{ color: '#555', fontSize: 14, marginBottom: '1.25rem' }}>
        Controls whether GEPA may evolve a given prompt slot and how rollouts proceed.
        <strong> mutable</strong> = GEPA + bandit exploration; <strong>guarded</strong> = GEPA can
        propose but rollout needs human approval; <strong>frozen</strong> = locked at stable-v0,
        no candidates accepted. Freezing requires an RFC link (Mutation-Freeze policy §7.4.3).
      </p>

      <MutationFilters initialRole={sp.role ?? ''} initialStatus={sp.status ?? ''} />

      {fetchError && (
        <p style={{ color: '#c00', marginBottom: '1rem' }}>
          Failed to load mutation data: {fetchError}
        </p>
      )}

      {slots.length === 0 ? (
        <div style={{
          padding: '1.25rem', background: '#f9fafb', border: '1px solid #e5e7eb',
          borderRadius: 6, color: '#666', fontSize: 14, marginTop: '1rem',
        }}>
          No slots match the current filter. {sp.role || sp.status ? 'Try removing a filter.' : 'No prompt_versions rows exist yet.'}
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: '1rem' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e5e5', textAlign: 'left' }}>
              <th style={{ padding: '0.5rem 0.75rem' }}>Status</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Slot ID</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Role</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Reason / RFC</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Last change</th>
              <th style={{ padding: '0.5rem 0.75rem', width: 280 }}>Change status</th>
            </tr>
          </thead>
          <tbody>
            {slots.map(s => {
              const style = STATUS_STYLES[s.mutationStatus];
              return (
                <tr key={`${s.role}:${s.slotId}`} style={{ borderBottom: '1px solid #f0f0f0', verticalAlign: 'top' }}>
                  <td style={{ padding: '0.6rem 0.75rem' }}>
                    <span style={{
                      display: 'inline-block', padding: '0.15rem 0.5rem', fontSize: 12, fontWeight: 600,
                      background: style.bg, color: style.text, border: `1px solid ${style.border}`,
                      borderRadius: 4,
                    }}>
                      {style.icon} {style.label}
                    </span>
                  </td>
                  <td style={{ padding: '0.6rem 0.75rem', fontFamily: 'monospace', fontSize: 12 }}>
                    {s.slotId}
                  </td>
                  <td style={{ padding: '0.6rem 0.75rem', color: '#444' }}>{s.role}</td>
                  <td style={{ padding: '0.6rem 0.75rem', color: '#555', fontSize: 12, maxWidth: 320 }}>
                    {s.freezeReason ?? <span style={{ color: '#999' }}>—</span>}
                    {s.lastRfcUrl && (
                      <div style={{ marginTop: '0.25rem' }}>
                        <a href={s.lastRfcUrl} target="_blank" rel="noopener noreferrer"
                           style={{ color: '#1d4ed8', fontSize: 11 }}>
                          RFC ↗
                        </a>
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '0.6rem 0.75rem', fontSize: 12, color: '#666' }}>
                    {s.lastChangedAt
                      ? <>
                          {new Date(s.lastChangedAt).toLocaleDateString()}<br/>
                          <span style={{ fontSize: 11, color: '#888' }}>by {s.lastChangedBy}</span>
                        </>
                      : <span style={{ color: '#999' }}>never</span>}
                  </td>
                  <td style={{ padding: '0.6rem 0.75rem' }}>
                    <MutationStatusControls
                      slotId={s.slotId}
                      role={s.role}
                      currentStatus={s.mutationStatus}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
