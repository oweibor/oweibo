import type { Metadata } from 'next';
import Link from 'next/link';
import { requireScope } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';
import { pipelineApi } from '@/lib/api';

export const metadata: Metadata = { title: 'GEPA Candidates' };

interface GepaRun {
  id:                  string;
  runDate:             string;
  status:              'running' | 'completed' | 'failed' | 'budget_exceeded';
  slotsProcessed:      number;
  candidatesGenerated: number;
  frontierSize:        number;
  costUsd:             number;
  startedAt:           string;
  completedAt:         string | null;
  error:               string | null;
}

interface CandidateRow {
  hash:           string;
  role:           string;
  slotId:         string;
  templateVersion: string;
  parentHash:     string | null;
  mutationStatus: string;
  evalScore:      Record<string, unknown> | null;
  createdAt:      string;
  updatedBy:      string | null;
  textPreview:    string;
}

interface CostPoint { day: string; costUsd: number; runs: number }
interface VelocityRow {
  slotId:        string;
  velocityTier:  'healthy' | 'slowing' | 'stagnating' | 'converged';
  delta7d:       number;
  deltaBaseline: number;
  computedAt:    string;
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  running:         { bg: '#dbeafe', text: '#1e3a8a' },
  completed:       { bg: '#d1fae5', text: '#065f46' },
  failed:          { bg: '#fee2e2', text: '#991b1b' },
  budget_exceeded: { bg: '#fef3c7', text: '#92400e' },
};

const VELOCITY_COLORS: Record<string, { bg: string; text: string }> = {
  healthy:    { bg: '#d1fae5', text: '#065f46' },
  slowing:    { bg: '#fef3c7', text: '#92400e' },
  stagnating: { bg: '#fed7aa', text: '#9a3412' },
  converged:  { bg: '#e0e7ff', text: '#3730a3' },
};

const MUTATION_COLORS: Record<string, { bg: string; text: string }> = {
  stable:               { bg: '#d1fae5', text: '#065f46' },
  beta:                 { bg: '#fef3c7', text: '#92400e' },
  fast:                 { bg: '#fee2e2', text: '#991b1b' },
  guarded:              { bg: '#e0e7ff', text: '#3730a3' },
  frozen:               { bg: '#e5e7eb', text: '#374151' },
  pending_human_review: { bg: '#dbeafe', text: '#1e3a8a' },
  retired:              { bg: '#f3f4f6', text: '#6b7280' },
};

export default async function PromptsPage() {
  await requireScope('platform:admin');

  let runs:       GepaRun[]      = [];
  let candidates: CandidateRow[] = [];
  let costs:      CostPoint[]    = [];
  let velocity:   VelocityRow[]  = [];
  let fetchError: string | null  = null;

  try {
    const [r, c, co, v] = await Promise.all([
      pipelineApi.get<{ runs: GepaRun[] }>('/platform/prompts/runs?limit=14'),
      pipelineApi.get<{ candidates: CandidateRow[] }>('/platform/prompts/candidates?limit=30'),
      pipelineApi.get<{ series: CostPoint[]; days: number }>('/platform/prompts/costs?days=14'),
      pipelineApi.get<{ slots: VelocityRow[] }>('/platform/prompts/velocity'),
    ]);
    runs       = r.runs       ?? [];
    candidates = c.candidates ?? [];
    costs      = co.series    ?? [];
    velocity   = v.slots      ?? [];
  } catch (err: unknown) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  const totalCost = costs.reduce((acc, p) => acc + p.costUsd, 0);
  const maxCost   = costs.length > 0 ? Math.max(...costs.map(p => p.costUsd), 0.01) : 0.01;

  return (
    <>
      <PageHeader
        title="GEPA Candidates"
        subtitle="§8.4 — nightly Pareto evolution of prompt slots"
      />

      <p style={{ color: '#555', fontSize: 14, marginBottom: '1.5rem' }}>
        Read-only window into the GEPA optimizer: nightly runs, recent candidates produced,
        cost burn-down, and per-slot velocity classification. Promotion decisions happen in{' '}
        <Link href="/platform/promotions" style={{ color: '#1d4ed8' }}>Promotion Approvals</Link>;
        freeze/guard status lives in{' '}
        <Link href="/platform/prompts/mutations" style={{ color: '#1d4ed8' }}>Mutation Governance</Link>.
      </p>

      {fetchError && (
        <p style={{ color: '#c00', marginBottom: '1rem' }}>
          Failed to load GEPA data: {fetchError}
        </p>
      )}

      {/* ── Cost burn-down ─────────────────────────────────────────────────── */}
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: '0.5rem' }}>
        Cost — last {costs.length || 0} days{' '}
        <span style={{ fontSize: 13, fontWeight: 400, color: '#666' }}>
          (total ${totalCost.toFixed(2)})
        </span>
      </h2>
      {costs.length === 0 ? (
        <p style={{ color: '#666', fontSize: 14, marginBottom: '2rem' }}>No GEPA runs in the window.</p>
      ) : (
        <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 96, marginBottom: '0.5rem', borderBottom: '1px solid #e5e7eb', padding: '0 0 0.25rem 0' }}>
          {costs.map(p => {
            const h = Math.max(4, Math.round((p.costUsd / maxCost) * 88));
            return (
              <div key={p.day} title={`${p.day}: $${p.costUsd.toFixed(2)} (${p.runs} run${p.runs === 1 ? '' : 's'})`}
                   style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{
                  width: '100%', height: h,
                  background: '#60a5fa', borderRadius: '2px 2px 0 0',
                }} />
              </div>
            );
          })}
        </div>
      )}
      {costs.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#888', marginBottom: '2rem' }}>
          <span>{costs[0]?.day}</span>
          <span>{costs[costs.length - 1]?.day}</span>
        </div>
      )}

      {/* ── Recent runs ────────────────────────────────────────────────────── */}
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: '0.75rem' }}>
        Recent runs
      </h2>
      {runs.length === 0 ? (
        <p style={{ color: '#666', fontSize: 14, marginBottom: '2rem' }}>No GEPA runs recorded.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: '2rem' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e5e5', textAlign: 'left' }}>
              <th style={{ padding: '0.4rem 0.75rem' }}>Date</th>
              <th style={{ padding: '0.4rem 0.75rem' }}>Status</th>
              <th style={{ padding: '0.4rem 0.75rem', textAlign: 'right' }}>Slots</th>
              <th style={{ padding: '0.4rem 0.75rem', textAlign: 'right' }}>Candidates</th>
              <th style={{ padding: '0.4rem 0.75rem', textAlign: 'right' }}>Frontier</th>
              <th style={{ padding: '0.4rem 0.75rem', textAlign: 'right' }}>Cost</th>
              <th style={{ padding: '0.4rem 0.75rem' }}>Duration</th>
            </tr>
          </thead>
          <tbody>
            {runs.map(r => {
              const dur = r.completedAt
                ? Math.round((new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime()) / 60_000)
                : null;
              const sc = STATUS_COLORS[r.status] ?? { bg: '#f3f4f6', text: '#374151' };
              return (
                <tr key={r.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={{ padding: '0.4rem 0.75rem', fontFamily: 'monospace', fontSize: 12 }}>
                    {r.runDate}
                  </td>
                  <td style={{ padding: '0.4rem 0.75rem' }}>
                    <span style={{
                      display: 'inline-block', padding: '0.1rem 0.4rem', fontSize: 11, fontWeight: 600,
                      background: sc.bg, color: sc.text, borderRadius: 3,
                    }}>
                      {r.status}
                    </span>
                  </td>
                  <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right' }}>{r.slotsProcessed}</td>
                  <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right' }}>{r.candidatesGenerated}</td>
                  <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right' }}>{r.frontierSize}</td>
                  <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>
                    ${r.costUsd.toFixed(2)}
                  </td>
                  <td style={{ padding: '0.4rem 0.75rem', color: '#666' }}>
                    {dur != null ? `${dur} min` : <span style={{ color: '#999' }}>—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* ── Velocity tiers ────────────────────────────────────────────────── */}
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: '0.75rem' }}>
        Velocity tiers {velocity.length > 0 && <span style={{ fontSize: 13, fontWeight: 400, color: '#666' }}>({velocity.length} slots)</span>}
      </h2>
      {velocity.length === 0 ? (
        <p style={{ color: '#666', fontSize: 14, marginBottom: '2rem' }}>
          No velocity data — runs <code>apps/gepa-velocity-tracker</code> weekly to populate.
        </p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: '2rem' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e5e5', textAlign: 'left' }}>
              <th style={{ padding: '0.4rem 0.75rem' }}>Slot</th>
              <th style={{ padding: '0.4rem 0.75rem' }}>Tier</th>
              <th style={{ padding: '0.4rem 0.75rem', textAlign: 'right' }}>Δ 7d</th>
              <th style={{ padding: '0.4rem 0.75rem', textAlign: 'right' }}>Δ baseline</th>
              <th style={{ padding: '0.4rem 0.75rem', textAlign: 'right' }}>Ratio</th>
            </tr>
          </thead>
          <tbody>
            {velocity.map(v => {
              const vc = VELOCITY_COLORS[v.velocityTier] ?? { bg: '#f3f4f6', text: '#374151' };
              const ratio = v.deltaBaseline > 0 ? v.delta7d / v.deltaBaseline : 0;
              return (
                <tr key={v.slotId} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={{ padding: '0.4rem 0.75rem', fontFamily: 'monospace', fontSize: 12 }}>
                    {v.slotId}
                  </td>
                  <td style={{ padding: '0.4rem 0.75rem' }}>
                    <span style={{
                      display: 'inline-block', padding: '0.1rem 0.4rem', fontSize: 11, fontWeight: 600,
                      background: vc.bg, color: vc.text, borderRadius: 3,
                    }}>
                      {v.velocityTier}
                    </span>
                  </td>
                  <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace', fontSize: 12 }}>
                    {v.delta7d.toFixed(4)}
                  </td>
                  <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace', fontSize: 12 }}>
                    {v.deltaBaseline.toFixed(4)}
                  </td>
                  <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace', fontSize: 12 }}>
                    {(ratio * 100).toFixed(0)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* ── Recent candidates ─────────────────────────────────────────────── */}
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: '0.75rem' }}>
        Recent candidates
      </h2>
      {candidates.length === 0 ? (
        <p style={{ color: '#666', fontSize: 14 }}>No prompt_versions rows yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e5e5', textAlign: 'left' }}>
              <th style={{ padding: '0.4rem 0.75rem' }}>Created</th>
              <th style={{ padding: '0.4rem 0.75rem' }}>Role</th>
              <th style={{ padding: '0.4rem 0.75rem' }}>Slot</th>
              <th style={{ padding: '0.4rem 0.75rem' }}>Status</th>
              <th style={{ padding: '0.4rem 0.75rem' }}>Hash</th>
              <th style={{ padding: '0.4rem 0.75rem' }}>By</th>
              <th style={{ padding: '0.4rem 0.75rem' }}></th>
            </tr>
          </thead>
          <tbody>
            {candidates.map(c => {
              const mc = MUTATION_COLORS[c.mutationStatus] ?? { bg: '#f3f4f6', text: '#374151' };
              return (
                <tr key={c.hash} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={{ padding: '0.4rem 0.75rem', fontSize: 11, color: '#666' }}>
                    {new Date(c.createdAt).toLocaleDateString()}
                  </td>
                  <td style={{ padding: '0.4rem 0.75rem' }}>{c.role}</td>
                  <td style={{ padding: '0.4rem 0.75rem', fontFamily: 'monospace', fontSize: 11 }}>{c.slotId}</td>
                  <td style={{ padding: '0.4rem 0.75rem' }}>
                    <span style={{
                      display: 'inline-block', padding: '0.1rem 0.4rem', fontSize: 11, fontWeight: 600,
                      background: mc.bg, color: mc.text, borderRadius: 3,
                    }}>
                      {c.mutationStatus}
                    </span>
                  </td>
                  <td style={{ padding: '0.4rem 0.75rem', fontFamily: 'monospace', fontSize: 11 }}>
                    {c.hash.slice(0, 12)}…
                  </td>
                  <td style={{ padding: '0.4rem 0.75rem', fontSize: 11, color: '#666' }}>
                    {c.updatedBy ?? <span style={{ color: '#bbb' }}>—</span>}
                  </td>
                  <td style={{ padding: '0.4rem 0.75rem', fontSize: 11 }}>
                    <Link href={`/platform/prompts/${encodeURIComponent(c.slotId)}/${encodeURIComponent(c.role)}`}
                          style={{ color: '#1d4ed8' }}>
                      frontier ↗
                    </Link>
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
