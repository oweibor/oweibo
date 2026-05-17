import type { Metadata } from 'next';
import { requireScope } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';
import { pipelineApi } from '@/lib/api';
import { PromotionDecisionControls } from './PromotionDecisionControls';

export const metadata: Metadata = { title: 'Promotion Approvals' };

interface GateCheck {
  name:     string;
  passed:   boolean;
  message:  string;
  required: number | boolean;
  actual:   number | boolean | null;
}

interface GateResult {
  allowed:   boolean;
  checks:    GateCheck[];
  blockedBy: string[];
}

export interface PendingPromotion {
  armId:       string;
  slotId:      string;
  role:        'architect' | 'executor' | 'reviewer' | 'decomposer';
  promptHash:  string;
  fromChannel: string;
  toChannel:   string;
  gateResult:  GateResult;
}

interface DecisionRecord {
  id:          string;
  armId:       string;
  slotId:      string;
  role:        string;
  fromChannel: string;
  toChannel:   string;
  promptHash:  string;
  decision:    'approved' | 'rejected';
  decidedBy:   string;
  decidedAt:   string;
  reason:      string;
}

export default async function PromotionsPage() {
  await requireScope('platform:admin');

  let pending:     PendingPromotion[] = [];
  let recent:      DecisionRecord[]   = [];
  let fetchError:  string | null      = null;

  try {
    const [p, r] = await Promise.all([
      pipelineApi.get<{ pending: PendingPromotion[] }>('/platform/promotions/pending'),
      pipelineApi.get<{ recent:  DecisionRecord[]   }>('/platform/promotions/recent?limit=20'),
    ]);
    pending = p.pending ?? [];
    recent  = r.recent  ?? [];
  } catch (err: unknown) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  return (
    <>
      <PageHeader
        title="Promotion Approvals"
        subtitle="§9.5 — human veto gate for beta → stable channel promotions"
      />

      <p style={{ color: '#555', fontSize: 14, marginBottom: '1.5rem' }}>
        Lists prompt-slot arms that have satisfied every automated gate (soak time, completion
        count, quality delta, safety violations) and are awaiting human approval to flip the
        channel pointer. <strong>Approval is irreversible</strong> — the new prompt becomes the
        live <code>stable</code> for every tenant on the channel. Rejecting an arm records the
        decision and removes it from this queue until a fresh GEPA run produces a new variant.
      </p>

      {fetchError && (
        <p style={{ color: '#c00', marginBottom: '1rem' }}>
          Failed to load promotion data: {fetchError}
        </p>
      )}

      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: '0.75rem' }}>
        Pending ({pending.length})
      </h2>

      {pending.length === 0 ? (
        <div style={{
          padding: '1.25rem', background: '#f9fafb', border: '1px solid #e5e7eb',
          borderRadius: 6, color: '#666', fontSize: 14, marginBottom: '2rem',
        }}>
          No arms awaiting human approval. Either no GEPA candidates have completed their soak,
          or every candidate has already been decided.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '2rem' }}>
          {pending.map(p => (
            <PendingCard key={`${p.slotId}:${p.armId}`} promotion={p} />
          ))}
        </div>
      )}

      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: '0.75rem' }}>
        Recent decisions
      </h2>

      {recent.length === 0 ? (
        <p style={{ color: '#666', fontSize: 14 }}>No decisions recorded yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e5e5', textAlign: 'left' }}>
              <th style={{ padding: '0.4rem 0.75rem' }}>When</th>
              <th style={{ padding: '0.4rem 0.75rem' }}>Slot / arm</th>
              <th style={{ padding: '0.4rem 0.75rem' }}>Direction</th>
              <th style={{ padding: '0.4rem 0.75rem' }}>Decision</th>
              <th style={{ padding: '0.4rem 0.75rem' }}>By</th>
              <th style={{ padding: '0.4rem 0.75rem' }}>Reason</th>
            </tr>
          </thead>
          <tbody>
            {recent.map(r => (
              <tr key={r.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={{ padding: '0.4rem 0.75rem', color: '#666' }}>
                  {new Date(r.decidedAt).toLocaleString()}
                </td>
                <td style={{ padding: '0.4rem 0.75rem', fontFamily: 'monospace', fontSize: 12 }}>
                  {r.slotId} / {r.armId.slice(0, 12)}…
                </td>
                <td style={{ padding: '0.4rem 0.75rem', fontSize: 12 }}>
                  {r.fromChannel} → {r.toChannel}
                </td>
                <td style={{ padding: '0.4rem 0.75rem', fontWeight: 600,
                  color: r.decision === 'approved' ? '#065f46' : '#991b1b' }}>
                  {r.decision}
                </td>
                <td style={{ padding: '0.4rem 0.75rem', color: '#555' }}>{r.decidedBy}</td>
                <td style={{ padding: '0.4rem 0.75rem', color: '#555' }}>{r.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function PendingCard({ promotion }: { promotion: PendingPromotion }) {
  const { gateResult } = promotion;
  const borderColor = gateResult.allowed ? '#86efac' : '#fcd34d';
  const bgColor     = gateResult.allowed ? '#f0fdf4' : '#fffbeb';

  return (
    <div style={{
      border: `1px solid ${borderColor}`, background: bgColor,
      borderRadius: 6, padding: '1rem 1.25rem',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', marginBottom: '0.75rem' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            {promotion.role} / <code style={{ fontSize: 13 }}>{promotion.slotId}</code>
          </div>
          <div style={{ fontSize: 12, color: '#666', marginTop: '0.2rem', fontFamily: 'monospace' }}>
            arm <span style={{ color: '#333' }}>{promotion.armId.slice(0, 16)}…</span>
            {' '}prompt <span style={{ color: '#333' }}>{promotion.promptHash.slice(0, 16)}…</span>
          </div>
        </div>
        <div style={{ fontSize: 13, color: '#555' }}>
          <strong>{promotion.fromChannel}</strong> → <strong>{promotion.toChannel}</strong>
        </div>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: '0.75rem' }}>
        <tbody>
          {gateResult.checks.map(c => (
            <tr key={c.name} style={{ borderBottom: '1px solid #f3f4f6' }}>
              <td style={{ padding: '0.3rem 0.5rem', width: 24 }}>
                {c.passed
                  ? <span style={{ color: '#16a34a', fontWeight: 700 }}>✓</span>
                  : <span style={{ color: '#dc2626', fontWeight: 700 }}>✗</span>}
              </td>
              <td style={{ padding: '0.3rem 0.5rem', fontFamily: 'monospace', color: '#444' }}>{c.name}</td>
              <td style={{ padding: '0.3rem 0.5rem', color: '#555' }}>{c.message}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <PromotionDecisionControls promotion={promotion} />
    </div>
  );
}
