import type { Metadata } from 'next';
import { pipelineApi } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Action history' };

interface ProposalSummary {
  id: string;
  actionClass: string;
  actionId: string;
  mode: string;
  summary: string;
  rollbackKind: string | null;
  state: string;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
}

const STATE_COLORS: Record<string, string> = {
  promoted: '#065f46',
  executed_live: '#065f46',
  executed_shadow: '#1e3a8a',
  rejected: '#991b1b',
  expired: '#525252',
};

export default async function ActionHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ class?: string }>;
}) {
  await params;
  const sp = await searchParams;
  const path = sp.class ? `/actions/history?class=${encodeURIComponent(sp.class)}` : '/actions/history';

  let items: ProposalSummary[] = [];
  let fetchError: string | null = null;
  try {
    const result = await pipelineApi.get<{ proposals: ProposalSummary[]; count: number }>(path);
    items = result.proposals ?? [];
  } catch (err: any) {
    fetchError = err.message;
  }

  return (
    <>
      <PageHeader
        title="Action history"
        subtitle={sp.class ? `${items.length} action${items.length !== 1 ? 's' : ''} · filter: ${sp.class}` : `${items.length} action${items.length !== 1 ? 's' : ''} decided`}
      />
      {fetchError && <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>}
      {items.length === 0 && !fetchError && <p>No decided actions found.</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {items.map((p) => (
          <div key={p.id} style={{ border: '1px solid #eee', borderRadius: 4, padding: '0.75rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{
                background: STATE_COLORS[p.state] ?? '#333',
                color: '#fff', fontSize: 11, padding: '2px 8px', borderRadius: 3,
              }}>{p.state}</span>
              <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#888' }}>{p.actionClass}</span>
            </div>
            <div style={{ fontSize: 13, marginBottom: 4 }}>{p.summary}</div>
            <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#888' }}>
              decided {p.decidedAt ? new Date(p.decidedAt).toLocaleString() : '—'}
              {p.decisionReason && <> · {p.decisionReason}</>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
