/**
 * S.7: forensic packet detail page.
 *
 * Loads the packet by planId, shows the proposals / executions /
 * verifications / rollbacks / inspections tree, and exposes four
 * resolution actions (resume / override / abort / lessons-learned).
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { pipelineApi } from '@/lib/api';
import { getSessionToken } from '@/lib/auth';
import { fetchOrThrow } from '@/lib/serverFetch';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Forensic packet' };

interface DetailResponse {
  packet: {
    id: string;
    planId: string;
    summary: string | null;
    triggerKind: string;
    state: string;
    storageRef: string;
    signature: string;
    createdAt: string;
    expiresAt: string;
    proposals: Array<{
      proposalId: string;
      actionClass: string;
      mode: string;
      state: string;
      summary: string;
      createdAt: string;
      decidedAt: string | null;
      decisionReason: string | null;
    }>;
    executions: Array<{
      proposalId: string;
      actionClass: string;
      outcome: 'success' | 'failure';
      executedAt: string;
    }>;
    verifications: Array<{
      verifierName: string;
      timing: string;
      driftSeverity: number;
      verifiedAt: string;
    }>;
    rollbacks: Array<{
      originalActionId: string;
      adapterName: string;
      resultState: string | null;
      startedAt: string;
    }>;
    inspections: Array<{
      inspectorName: string;
      verdict: string;
      reason: string | null;
    }>;
    suggestedActions: string[];
  } | null;
}

async function resolvePacketAction(formData: FormData): Promise<void> {
  'use server';
  const tenantId = formData.get('tenantId') as string;
  const packetId = formData.get('packetId') as string;
  const resolution = formData.get('resolution') as string;
  const notes = (formData.get('notes') as string) || '';
  const token = await getSessionToken();
  const PIPELINE_URL = process.env['PIPELINE_URL'] ?? 'http://localhost:3100/api/v1';
  await fetchOrThrow('resolve forensic packet', `${PIPELINE_URL}/tenants/${tenantId}/forensics/${packetId}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ resolution, notes }),
  });
  redirect(`/t/${tenantId}/forensics`);
}

export default async function ForensicDetailPage({ params }: { params: Promise<{ tenantId: string; planId: string }> }) {
  const { tenantId, planId } = await params;

  let data: DetailResponse = { packet: null };
  let fetchError: string | null = null;
  try {
    data = await pipelineApi.get<DetailResponse>(`/tenants/${tenantId}/forensics/by-plan/${planId}`);
  } catch (err: any) {
    fetchError = err.message;
  }

  const pkt = data.packet;
  if (!pkt && !fetchError) {
    return (
      <>
        <PageHeader title="Forensic packet" subtitle={`plan ${planId}`} />
        <p style={{ color: '#666' }}>No packet found for this plan.</p>
      </>
    );
  }
  if (!pkt) {
    return (
      <>
        <PageHeader title="Forensic packet" subtitle={`plan ${planId}`} />
        <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>
      </>
    );
  }

  const open = pkt.state === 'open' || pkt.state === 'under_review';

  return (
    <>
      <PageHeader
        title="Forensic packet"
        subtitle={pkt.summary ?? `plan ${planId}`}
      />

      <section style={{ marginBottom: '1.5rem' }}>
        <div style={{ fontSize: 12, color: '#525252', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          <span>state: <strong>{pkt.state}</strong></span>
          <span>trigger: <strong>{pkt.triggerKind}</strong></span>
          <span>created: {new Date(pkt.createdAt).toLocaleString()}</span>
          <span>expires: {new Date(pkt.expiresAt).toLocaleString()}</span>
        </div>
        <div style={{ fontSize: 11, color: '#888', marginTop: 4, fontFamily: 'monospace' }}>
          storage_ref={pkt.storageRef} · signature={pkt.signature.slice(0, 16)}…
        </div>
      </section>

      <Section title={`Proposals (${pkt.proposals.length})`}>
        {pkt.proposals.map((p) => (
          <div key={p.proposalId} style={rowStyle}>
            <code style={{ fontSize: 11 }}>{p.proposalId.slice(0, 8)}…</code>
            <span>{p.actionClass}</span>
            <span style={badgeFor(p.state)}>{p.state}</span>
            <span style={{ flex: 1, color: '#525252', fontSize: 12 }}>{p.summary}</span>
            {p.decisionReason && (
              <span style={{ fontSize: 11, color: '#888' }}>{p.decisionReason}</span>
            )}
          </div>
        ))}
      </Section>

      <Section title={`Executions (${pkt.executions.length})`}>
        {pkt.executions.map((e, i) => (
          <div key={i} style={rowStyle}>
            <code style={{ fontSize: 11 }}>{e.proposalId.slice(0, 8)}…</code>
            <span>{e.actionClass}</span>
            <span style={badgeFor(e.outcome)}>{e.outcome}</span>
            <span style={{ flex: 1, fontSize: 12, color: '#888' }}>
              {new Date(e.executedAt).toLocaleString()}
            </span>
          </div>
        ))}
      </Section>

      <Section title={`Verifications (${pkt.verifications.length})`}>
        {pkt.verifications.map((v, i) => (
          <div key={i} style={rowStyle}>
            <span>{v.verifierName}</span>
            <span style={{ fontSize: 11, color: '#888' }}>{v.timing}</span>
            <span style={{
              background: v.driftSeverity >= 3 ? '#991b1b' : v.driftSeverity >= 2 ? '#b45309' : '#525252',
              color: '#fff', fontSize: 10, padding: '2px 6px', borderRadius: 3,
            }}>SEV {v.driftSeverity}</span>
            <span style={{ flex: 1, fontSize: 12, color: '#888' }}>
              {new Date(v.verifiedAt).toLocaleString()}
            </span>
          </div>
        ))}
      </Section>

      <Section title={`Rollbacks (${pkt.rollbacks.length})`}>
        {pkt.rollbacks.map((r, i) => (
          <div key={i} style={rowStyle}>
            <code style={{ fontSize: 11 }}>{r.originalActionId.slice(0, 8)}…</code>
            <span>{r.adapterName}</span>
            <span style={badgeFor(r.resultState ?? 'pending')}>{r.resultState ?? 'pending'}</span>
          </div>
        ))}
      </Section>

      <Section title={`Inspections (${pkt.inspections.length})`}>
        {pkt.inspections.map((i, idx) => (
          <div key={idx} style={rowStyle}>
            <span>{i.inspectorName}</span>
            <span style={badgeFor(i.verdict)}>{i.verdict}</span>
            <span style={{ flex: 1, fontSize: 12, color: '#888' }}>{i.reason}</span>
          </div>
        ))}
      </Section>

      {pkt.suggestedActions.length > 0 && (
        <Section title="Suggested actions">
          <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: 13 }}>
            {pkt.suggestedActions.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </Section>
      )}

      {open && (
        <section>
          <h3 style={{ marginBottom: '0.5rem', fontSize: 14, color: '#525252' }}>Resolve</h3>
          <form action={resolvePacketAction} style={{
            border: '1px solid #e5e5e5', borderRadius: 6, padding: '1rem',
            display: 'flex', flexDirection: 'column', gap: '0.75rem',
          }}>
            <input type="hidden" name="tenantId" value={tenantId} />
            <input type="hidden" name="packetId" value={pkt.id} />
            <label style={{ fontSize: 12, color: '#525252' }}>
              Resolution
              <select name="resolution" required defaultValue="resumed" style={{
                display: 'block', width: 240, padding: '0.35rem', marginTop: 4,
                border: '1px solid #ccc', borderRadius: 4, fontSize: 13,
              }}>
                <option value="resumed">resumed (continue plan)</option>
                <option value="overridden">overridden (operator decision)</option>
                <option value="aborted">aborted (stop plan)</option>
                <option value="lessons_learned">lessons_learned (archive + feedback)</option>
              </select>
            </label>
            <label style={{ fontSize: 12, color: '#525252' }}>
              Notes (optional)
              <textarea name="notes" rows={3} style={{
                display: 'block', width: '100%', padding: '0.35rem', marginTop: 4,
                border: '1px solid #ccc', borderRadius: 4, fontSize: 13,
              }} />
            </label>
            <button type="submit" style={{
              alignSelf: 'flex-start', padding: '0.4rem 1rem',
              background: '#065f46', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13,
            }}>Resolve packet</button>
          </form>
        </section>
      )}
    </>
  );
}

const rowStyle: React.CSSProperties = {
  display: 'flex', gap: '0.75rem', alignItems: 'center',
  borderBottom: '1px solid #f5f5f5', padding: '0.4rem 0.5rem', fontSize: 13,
};

function badgeFor(s: string): React.CSSProperties {
  const colorMap: Record<string, string> = {
    executed_live: '#065f46', executed_shadow: '#525252',
    success: '#065f46', failure: '#991b1b', failed: '#991b1b',
    rolled_back: '#525252', rollback_failed: '#991b1b',
    rejected: '#991b1b', allow: '#065f46', upgrade_to_approval: '#b45309', forbid: '#991b1b',
    fully_reverted: '#065f46', partial: '#b45309', no_op_already_reverted: '#525252',
    pending: '#525252',
  };
  return {
    background: colorMap[s] ?? '#525252', color: '#fff', fontSize: 10,
    padding: '2px 6px', borderRadius: 3, textTransform: 'uppercase',
  };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: '1.5rem' }}>
      <h3 style={{ marginBottom: '0.5rem', fontSize: 14, color: '#525252' }}>{title}</h3>
      <div style={{ border: '1px solid #e5e5e5', borderRadius: 6, padding: '0.25rem 0.5rem' }}>
        {children}
      </div>
    </section>
  );
}
