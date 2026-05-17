import type { Metadata } from 'next';
import Link from 'next/link';
import { requireScope } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';
import { pipelineApi } from '@/lib/api';

export const metadata: Metadata = { title: 'Slot Frontier' };

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
  liveOnChannels: string[];
  banditAlpha?:   number;
  banditBeta?:    number;
}

interface ChannelRow { name: string; promptHash: string; version: string }

function meanReward(alpha?: number, beta?: number): number | null {
  if (alpha == null || beta == null) return null;
  return alpha / (alpha + beta);
}

function pickHeadlineScore(evalScore: Record<string, unknown> | null): number | null {
  if (!evalScore) return null;
  // Prefer 'composite', then any numeric value
  if (typeof evalScore['composite'] === 'number') return evalScore['composite'] as number;
  for (const v of Object.values(evalScore)) {
    if (typeof v === 'number') return v;
  }
  return null;
}

export default async function SlotFrontierPage({
  params,
}: {
  params: Promise<{ slot: string; role: string }>;
}) {
  await requireScope('platform:admin');
  const { slot, role } = await params;

  let candidates: CandidateRow[]  = [];
  let channels:   ChannelRow[]    = [];
  let fetchError: string | null   = null;

  try {
    const result = await pipelineApi.get<{ candidates: CandidateRow[]; channels: ChannelRow[] }>(
      `/platform/prompts/frontier/${encodeURIComponent(slot)}/${encodeURIComponent(role)}`,
    );
    candidates = result.candidates ?? [];
    channels   = result.channels   ?? [];
  } catch (err: unknown) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  // Rank by headline score descending, with live-on-channels candidates pinned to top of their score
  const ranked = [...candidates].sort((a, b) => {
    const sa = pickHeadlineScore(a.evalScore) ?? -Infinity;
    const sb = pickHeadlineScore(b.evalScore) ?? -Infinity;
    return sb - sa;
  });

  return (
    <>
      <PageHeader
        title={`${role} / ${slot}`}
        subtitle="§8.4.3 — frontier of candidates for this slot+role"
      />

      <p style={{ marginBottom: '1rem', fontSize: 13 }}>
        <Link href="/platform/prompts" style={{ color: '#1d4ed8' }}>← back to GEPA Candidates</Link>
      </p>

      {fetchError && (
        <p style={{ color: '#c00', marginBottom: '1rem' }}>
          Failed to load frontier: {fetchError}
        </p>
      )}

      {/* Live channel pointers */}
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: '0.5rem' }}>Live channel pointers</h2>
      {channels.length === 0 ? (
        <p style={{ color: '#666', fontSize: 14, marginBottom: '1.5rem' }}>
          No channel pointers for this slot+role yet.
        </p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: '1.5rem' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e5e5', textAlign: 'left' }}>
              <th style={{ padding: '0.4rem 0.75rem' }}>Channel</th>
              <th style={{ padding: '0.4rem 0.75rem' }}>Current prompt hash</th>
              <th style={{ padding: '0.4rem 0.75rem', textAlign: 'right' }}>Version</th>
            </tr>
          </thead>
          <tbody>
            {channels.map(c => (
              <tr key={c.name} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={{ padding: '0.4rem 0.75rem', fontWeight: 600 }}>{c.name}</td>
                <td style={{ padding: '0.4rem 0.75rem', fontFamily: 'monospace', fontSize: 12 }}>
                  {c.promptHash.slice(0, 24)}…
                </td>
                <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>
                  v{c.version}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Candidates */}
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: '0.5rem' }}>
        Candidates ({ranked.length})
      </h2>

      {ranked.length === 0 ? (
        <p style={{ color: '#666', fontSize: 14 }}>No candidates for this slot+role.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {ranked.map(c => {
            const score = pickHeadlineScore(c.evalScore);
            const mean  = meanReward(c.banditAlpha, c.banditBeta);
            const isLive = c.liveOnChannels.length > 0;
            return (
              <div key={c.hash} style={{
                border: `1px solid ${isLive ? '#86efac' : '#e5e7eb'}`,
                background: isLive ? '#f0fdf4' : '#ffffff',
                borderRadius: 6, padding: '0.85rem 1rem',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#444' }}>
                      {c.hash.slice(0, 24)}…
                      {c.parentHash && (
                        <span style={{ color: '#888', marginLeft: '0.5rem' }}>
                          (← {c.parentHash.slice(0, 12)}…)
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: '#666', marginTop: '0.25rem' }}>
                      {new Date(c.createdAt).toLocaleString()} · by {c.updatedBy ?? '—'} · status <strong>{c.mutationStatus}</strong>
                    </div>
                    {c.liveOnChannels.length > 0 && (
                      <div style={{ fontSize: 12, marginTop: '0.25rem' }}>
                        <span style={{ color: '#065f46', fontWeight: 600 }}>live on:</span>{' '}
                        {c.liveOnChannels.map(ch => (
                          <span key={ch} style={{
                            display: 'inline-block', marginRight: '0.25rem',
                            padding: '0.05rem 0.4rem', background: '#d1fae5', color: '#065f46',
                            fontSize: 11, fontWeight: 600, borderRadius: 3,
                          }}>
                            {ch}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: 'right', fontSize: 12, color: '#555', minWidth: 160 }}>
                    {score != null && (
                      <div>
                        <span style={{ color: '#888' }}>eval score</span>
                        <div style={{ fontSize: 18, fontWeight: 700, color: '#1a1a1a', fontFamily: 'monospace' }}>
                          {score.toFixed(3)}
                        </div>
                      </div>
                    )}
                    {mean != null && (
                      <div style={{ marginTop: '0.4rem' }}>
                        <span style={{ color: '#888' }}>bandit mean</span>
                        <div style={{ fontFamily: 'monospace', color: '#444' }}>
                          {mean.toFixed(3)} <span style={{ color: '#999', fontSize: 10 }}>α={c.banditAlpha?.toFixed(1)} β={c.banditBeta?.toFixed(1)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* eval_score detail */}
                {c.evalScore && Object.keys(c.evalScore).length > 0 && (
                  <details style={{ marginTop: '0.5rem' }}>
                    <summary style={{ fontSize: 12, color: '#666', cursor: 'pointer' }}>eval_score detail</summary>
                    <pre style={{
                      fontSize: 11, background: '#f9fafb', padding: '0.4rem 0.6rem',
                      borderRadius: 4, marginTop: '0.3rem', overflowX: 'auto',
                    }}>
                      {JSON.stringify(c.evalScore, null, 2)}
                    </pre>
                  </details>
                )}

                {/* Text preview */}
                <details style={{ marginTop: '0.3rem' }}>
                  <summary style={{ fontSize: 12, color: '#666', cursor: 'pointer' }}>prompt text preview</summary>
                  <pre style={{
                    fontSize: 11, background: '#f9fafb', padding: '0.4rem 0.6rem',
                    borderRadius: 4, marginTop: '0.3rem', whiteSpace: 'pre-wrap',
                  }}>
                    {c.textPreview}{c.textPreview.length >= 400 ? '…' : ''}
                  </pre>
                </details>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
