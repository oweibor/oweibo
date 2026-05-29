/**
 * F.4.8 / F.4.5: SME review queue page.
 *
 *   GET  /tenants/:tenantId/domains/sme-review            — list queue items
 *   POST /tenants/:tenantId/domains/sme-review/:id/vote   — submit review
 *
 * The queue lists every item the tenant owns across pending / assigned /
 * reviewed states. Each row carries an inline vote form that posts the
 * reviewer's overall verdict + an optional comment. UNIQUE conflicts
 * (re-submission) surface as 409 from the route; the form post
 * preserves the queue page and shows the failure message.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { pipelineApi } from '@/lib/api';
import { getSessionToken } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'SME review queue' };

type QueueState = 'pending' | 'assigned' | 'reviewed' | 'aggregated' | 'closed';
type ArtifactKind = 'memory' | 'rubric' | 'rule' | 'ontology_term' | 'rationale';
type OverallVerdict = 'accept' | 'reject' | 'request_changes' | 'abstain';

interface QueueItem {
  id: string;
  domainSlug: string;
  tenantId: string;
  taskId: string | null;
  artifactKind: ArtifactKind;
  artifactRef: Record<string, unknown>;
  anonymizedPayload: unknown;
  state: QueueState;
  requiredReviews: number;
  sampledAt: string;
  closedAt: string | null;
}

async function submitVoteAction(formData: FormData): Promise<void> {
  'use server';
  const tenantId = formData.get('tenantId') as string;
  const queueItemId = formData.get('queueItemId') as string;
  const overallVerdict = formData.get('overallVerdict') as OverallVerdict;
  const comment = (formData.get('comment') as string) || '';

  const token = await getSessionToken();
  const PIPELINE_URL = process.env['PIPELINE_URL'] ?? 'http://localhost:3100/api/v1';
  await fetch(
    `${PIPELINE_URL}/tenants/${tenantId}/domains/sme-review/${queueItemId}/vote`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        overallVerdict,
        ...(comment ? { comment } : {}),
      }),
    },
  );
  redirect(`/t/${tenantId}/domains/sme-review`);
}

export default async function SmeReviewPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;

  let items: QueueItem[] = [];
  let fetchError: string | null = null;
  try {
    const res = await pipelineApi.get<{ items: QueueItem[] }>(
      `/tenants/${tenantId}/domains/sme-review`,
    );
    items = res.items ?? [];
  } catch (err: unknown) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  const totals: Record<QueueState, number> = {
    pending: 0, assigned: 0, reviewed: 0, aggregated: 0, closed: 0,
  };
  for (const it of items) totals[it.state]++;

  return (
    <>
      <PageHeader
        title="SME review queue"
        subtitle={`${items.length} item(s) for review across ${Object.keys(totals).filter((k) => totals[k as QueueState] > 0).length} state(s)`}
      />
      {fetchError && (
        <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>
      )}

      {/* State summary */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
        {(['pending', 'assigned', 'reviewed'] as QueueState[]).map((s) => (
          <span key={s} style={{
            background: '#f5f5f5', border: '1px solid #e5e5e5', borderRadius: 4,
            padding: '0.25rem 0.6rem', fontSize: 12, color: '#525252',
          }}>
            <strong>{totals[s]}</strong> {s}
          </span>
        ))}
      </div>

      {items.length === 0 && !fetchError && (
        <p style={{ color: '#666', fontSize: 13 }}>
          No items in the review queue. Sampling worker enqueues items as
          artifacts are produced — check back once production traffic has run.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {items.map((it) => (
          <ReviewCard key={it.id} item={it} tenantId={tenantId} />
        ))}
      </div>
    </>
  );
}

function ReviewCard({ item, tenantId }: { item: QueueItem; tenantId: string }) {
  const canVote = item.state === 'pending' || item.state === 'assigned';
  return (
    <div style={{
      border: '1px solid #e5e5e5', borderRadius: 6,
      padding: '0.85rem 1rem',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem' }}>
        <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{item.id.slice(0, 8)}…</span>
        <span style={stateBadge(item.state)}>{item.state}</span>
        <span style={{ fontSize: 12, color: '#888' }}>{item.artifactKind}</span>
        <span style={{ fontSize: 12, color: '#525252' }}>{item.domainSlug}</span>
        <span style={{ fontSize: 11, color: '#888', marginLeft: 'auto' }}>
          required reviews: {item.requiredReviews}
        </span>
      </div>
      <div style={{ marginTop: 6, fontSize: 11, color: '#888' }}>
        sampled {new Date(item.sampledAt).toLocaleString()}
      </div>

      {/* Anonymized payload preview — keep it small and operator-readable. */}
      <details style={{ marginTop: 8 }}>
        <summary style={{ fontSize: 12, color: '#525252', cursor: 'pointer' }}>
          Anonymized payload
        </summary>
        <pre style={{
          marginTop: 6, padding: '0.5rem', background: '#fafafa',
          border: '1px solid #f0f0f0', borderRadius: 4,
          fontSize: 11, overflowX: 'auto',
        }}>{JSON.stringify(item.anonymizedPayload, null, 2)}</pre>
      </details>

      {canVote && (
        <form action={submitVoteAction} style={{
          marginTop: 12, display: 'flex', flexDirection: 'column', gap: '0.5rem',
          padding: '0.75rem', background: '#fafafa', borderRadius: 4,
        }}>
          <input type="hidden" name="tenantId" value={tenantId} />
          <input type="hidden" name="queueItemId" value={item.id} />
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <label style={{ fontSize: 12, color: '#525252' }}>
              Verdict:{' '}
              <select name="overallVerdict" required defaultValue="accept" style={{
                padding: '0.3rem', border: '1px solid #ccc', borderRadius: 4, fontSize: 13,
              }}>
                <option value="accept">accept</option>
                <option value="reject">reject</option>
                <option value="request_changes">request_changes</option>
                <option value="abstain">abstain</option>
              </select>
            </label>
            <input
              name="comment"
              placeholder="Optional comment"
              style={{
                flex: 1, padding: '0.3rem',
                border: '1px solid #ccc', borderRadius: 4, fontSize: 13,
              }}
            />
            <button type="submit" style={{
              padding: '0.35rem 1rem',
              background: '#065f46', color: '#fff', border: 'none',
              cursor: 'pointer', fontSize: 13,
            }}>Submit</button>
          </div>
        </form>
      )}
    </div>
  );
}

function stateBadge(state: QueueState): React.CSSProperties {
  const colorMap: Record<QueueState, string> = {
    pending: '#92400e',
    assigned: '#1e3a8a',
    reviewed: '#065f46',
    aggregated: '#525252',
    closed: '#525252',
  };
  return {
    background: colorMap[state], color: '#fff', fontSize: 10,
    padding: '2px 6px', borderRadius: 3, textTransform: 'uppercase',
  };
}
