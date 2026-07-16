/**
 * S.7: forensic packets list page.
 *
 * Shows every forensic packet for the tenant in reverse-chronological
 * order, grouped by state (open / under_review / resolved / archived).
 * Each row links to the detail page for the packet's plan.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { pipelineApi } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Forensics' };

interface ForensicRow {
  id: string;
  planId: string;
  triggerKind: 'manual' | 'auto_drift' | 'auto_rollback_failed' | 'auto_pattern' | 'compliance_request';
  state: 'open' | 'under_review' | 'resolved' | 'archived';
  summary: string | null;
  createdAt: string;
}

function stateBadge(state: ForensicRow['state']): { label: string; color: string } {
  switch (state) {
    case 'open':         return { label: 'OPEN', color: '#991b1b' };
    case 'under_review': return { label: 'REVIEW', color: '#b45309' };
    case 'resolved':     return { label: 'RESOLVED', color: '#065f46' };
    case 'archived':     return { label: 'ARCHIVED', color: '#525252' };
  }
}

function triggerLabel(t: ForensicRow['triggerKind']): string {
  switch (t) {
    case 'manual':                return 'manual';
    case 'auto_drift':            return 'auto: drift';
    case 'auto_rollback_failed':  return 'auto: rollback failed';
    case 'auto_pattern':          return 'auto: pattern';
    case 'compliance_request':    return 'compliance';
  }
}

export default async function ForensicsPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;

  let packets: ForensicRow[] = [];
  let fetchError: string | null = null;
  try {
    const res = await pipelineApi.get<{ packets: ForensicRow[] }>(`/tenants/${tenantId}/forensics`);
    packets = res.packets ?? [];
  } catch (err: any) {
    fetchError = err.message;
  }

  return (
    <>
      <PageHeader
        title="Forensic packets"
        subtitle="Signed audit-grade snapshots of action plans escalated to human review"
      />
      {fetchError && <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>}

      {packets.length === 0 && !fetchError && (
        <p style={{ color: '#666', fontSize: 13 }}>
          No forensic packets yet. Operators trigger handoffs manually from a plan,
          or the system auto-fires one when severity-3 drift is detected.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {packets.map((p) => {
          const badge = stateBadge(p.state);
          return (
            <Link
              key={p.id}
              href={`/t/${tenantId}/forensics/${p.planId}`}
              style={{
                display: 'block', textDecoration: 'none', color: 'inherit',
                border: '1px solid #e5e5e5', borderRadius: 6, padding: '0.75rem 1rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem' }}>
                <span style={{
                  background: badge.color, color: '#fff', fontSize: 10,
                  padding: '2px 6px', borderRadius: 3,
                }}>{badge.label}</span>
                <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{p.id.slice(0, 8)}…</span>
                <span style={{ fontSize: 12, color: '#888' }}>{triggerLabel(p.triggerKind)}</span>
                <span style={{ fontSize: 12, color: '#888', marginLeft: 'auto' }}>
                  {new Date(p.createdAt).toLocaleString()}
                </span>
              </div>
              {p.summary && (
                <div style={{ fontSize: 13, color: '#525252', marginTop: 6 }}>
                  {p.summary}
                </div>
              )}
              <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                plan <code>{p.planId.slice(0, 8)}…</code>
              </div>
            </Link>
          );
        })}
      </div>
    </>
  );
}
