/**
 * K.9: connector-fabric governance page.
 *
 * Two planes, one page:
 *   - TENANT POLICY (ADR-006): the eight dimensions with their fixed
 *     category, the monotonic policy version, and a propose form. A
 *     tightening applies immediately; a relaxation is answered with
 *     "needs dual control" — there is deliberately no way to apply one
 *     from this page (a second authorized approver is a person, not a
 *     form field).
 *   - CONNECTOR ROLLOUT (ADR-004 §3.7): look up a connector's deployment
 *     (state, active/target version, the version new jobs mint at) and
 *     drive canary / promote / rollback.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { pipelineApi } from '@/lib/api';
import { getSessionToken } from '@/lib/auth';
import { fetchOrThrow } from '@/lib/serverFetch';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Fabric governance' };

const PIPELINE_URL = process.env['PIPELINE_URL'] ?? 'http://localhost:3100/api/v1';

interface PolicyDimensionRow {
  dimension: string;
  category: 'compliance' | 'operational';
  value: Record<string, unknown>;
}

interface Deployment {
  connectorId: string;
  activeVersion: string;
  targetVersion?: string;
  state: 'stable' | 'canary' | 'rolling_back';
  tenantCohort: string;
  canaryCohort?: string;
}

interface RelaxationProposal {
  id: string;
  proposerUserId: string;
  summary: string;
  state: string;
  createdAt: string;
  expiresAt: string;
}

// ── Server actions ─────────────────────────────────────────────────────────

async function proposePolicyAction(formData: FormData): Promise<void> {
  'use server';
  const tenantId = formData.get('tenantId') as string;
  const dimension = formData.get('dimension') as string;
  const valueJson = formData.get('value') as string;
  const mode = formData.get('mode') as string; // 'simulate' | 'propose'

  let value: unknown;
  try {
    value = JSON.parse(valueJson);
  } catch {
    redirect(`/t/${tenantId}/fabric?flash=${encodeURIComponent('Value must be valid JSON')}`);
  }

  const token = await getSessionToken();
  const path = mode === 'simulate' ? 'policy/simulate' : 'policy/propose';
  const res = await fetch(`${PIPELINE_URL}/tenants/${tenantId}/fabric/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ changes: [{ dimension, value: { kind: dimension, ...(value as object) } }] }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  let flash: string;
  if (res.status === 202 && body['kind'] === 'pending_approval') {
    flash = `Relaxation ballot opened (quorum ${String(body['quorum'])}). A second authorized approver must approve it below.`;
  } else if (res.status === 409 && body['error'] === 'needs_dual_control') {
    flash = `Relaxation refused: needs dual control (quorum ${String(body['quorum'])}) — the ballot flow is not configured on this deployment.`;
  } else if (!res.ok) {
    flash = `${mode} failed (${res.status}): ${JSON.stringify(body).slice(0, 300)}`;
  } else if (mode === 'simulate') {
    flash = `Simulated: ${String(body['classification'])} — dual control ${body['dualControlRequired'] ? 'REQUIRED' : 'not required'}, backfill ${body['backfillRequired'] ? 'REQUIRED' : 'not required'}, ~${String(body['affectedDocuments'])} documents affected.`;
  } else if (body['kind'] === 'no_change') {
    flash = 'No change: the proposed value is semantically identical to the current policy.';
  } else {
    flash = `Applied at policy version ${String(body['policyVersion'])}${body['backfillRequired'] ? ' — mandatory backfill scheduled' : ''}.`;
  }
  redirect(`/t/${tenantId}/fabric?flash=${encodeURIComponent(flash)}`);
}

async function voteRelaxationAction(formData: FormData): Promise<void> {
  'use server';
  const tenantId = formData.get('tenantId') as string;
  const proposalId = formData.get('proposalId') as string;
  const vote = formData.get('vote') as string; // 'approve' | 'reject'

  const token = await getSessionToken();
  const res = await fetch(
    `${PIPELINE_URL}/tenants/${tenantId}/fabric/policy/relaxations/${encodeURIComponent(proposalId)}/votes`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ vote }),
    },
  );
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  let flash: string;
  if (!res.ok) {
    flash = body['error'] === 'already_resolved'
      ? `Ballot already resolved (${String(body['state'])}).`
      : `Vote failed (${res.status}): ${JSON.stringify(body).slice(0, 300)}`;
  } else if (body['kind'] === 'applied') {
    flash = `Quorum reached — relaxation APPLIED at policy version ${String(body['policyVersion'])}.`;
  } else if (body['kind'] === 'vetoed') {
    flash = 'Dissent veto — the relaxation was rejected.';
  } else if (body['kind'] === 'no_change') {
    flash = 'Quorum reached, but the change was already effective (no-op).';
  } else {
    flash = `Vote recorded — ${String(body['approvals'])}/${String(body['quorum'])} approvals. Awaiting another authorized approver.`;
  }
  redirect(`/t/${tenantId}/fabric?flash=${encodeURIComponent(flash)}`);
}

async function rolloutAction(formData: FormData): Promise<void> {
  'use server';
  const tenantId = formData.get('tenantId') as string;
  const connectorId = formData.get('connectorId') as string;
  const op = formData.get('op') as string; // 'canary' | 'promote' | 'rollback'

  const token = await getSessionToken();
  const body =
    op === 'canary'
      ? JSON.stringify({
          targetVersion: formData.get('targetVersion') as string,
          canaryCohort: formData.get('canaryCohort') as string,
        })
      : undefined;
  await fetchOrThrow(
    `rollout ${op}`,
    `${PIPELINE_URL}/tenants/${tenantId}/fabric/connectors/${encodeURIComponent(connectorId)}/rollout/${op}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body ? { body } : {}),
    },
  );
  redirect(`/t/${tenantId}/fabric?connector=${encodeURIComponent(connectorId)}`);
}

// ── Page ───────────────────────────────────────────────────────────────────

export default async function FabricPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ connector?: string; flash?: string }>;
}) {
  const { tenantId } = await params;
  const { connector, flash } = await searchParams;

  let policyVersion = '?';
  let dimensions: PolicyDimensionRow[] = [];
  let fetchError: string | null = null;
  try {
    const res = await pipelineApi.get<{ policyVersion: string; dimensions: PolicyDimensionRow[] }>(
      `/tenants/${tenantId}/fabric/policy`,
    );
    policyVersion = res.policyVersion;
    dimensions = res.dimensions ?? [];
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  let relaxations: RelaxationProposal[] = [];
  let relaxationsNote: string | null = null;
  try {
    const res = await pipelineApi.get<{ proposals: RelaxationProposal[] }>(
      `/tenants/${tenantId}/fabric/policy/relaxations`,
    );
    relaxations = res.proposals ?? [];
  } catch (err) {
    const status = (err as { status?: number }).status;
    relaxationsNote = status === 503
      ? 'Ballot flow not configured on this deployment.'
      : `Failed to load ballots: ${err instanceof Error ? err.message : String(err)}`;
  }

  let deployment: Deployment | null = null;
  let mintVersion: string | null = null;
  let deploymentError: string | null = null;
  if (connector) {
    try {
      const res = await pipelineApi.get<{ deployment: Deployment; mintVersion: string }>(
        `/tenants/${tenantId}/fabric/connectors/${encodeURIComponent(connector)}/deployment`,
      );
      deployment = res.deployment;
      mintVersion = res.mintVersion;
    } catch (err) {
      deploymentError = err instanceof Error ? err.message : String(err);
    }
  }

  return (
    <>
      <PageHeader
        title="Fabric governance"
        subtitle="Tenant policy (ADR-006) and connector rollout (ADR-004 §3.7)"
      />
      {flash && (
        <p style={{
          border: '1px solid #d4d4d4', borderLeft: '4px solid #2563eb', borderRadius: 4,
          padding: '0.6rem 0.9rem', fontSize: 13, color: '#262626', background: '#f8fafc',
        }}>{flash}</p>
      )}
      {fetchError && <p style={{ color: '#c00' }}>Failed to load policy: {fetchError}</p>}

      {/* ── Policy plane ── */}
      <section style={{ marginBottom: '2rem' }}>
        <h3 style={{ marginBottom: '0.5rem', fontSize: 14, color: '#525252' }}>
          Effective policy — version <strong>{policyVersion}</strong>
          {policyVersion === '0' && <span style={{ color: '#737373' }}> (defaults; never committed)</span>}
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          {dimensions.map((d) => (
            <div key={d.dimension} style={{
              border: '1px solid #e5e5e5', borderRadius: 6, padding: '0.6rem 1rem',
              display: 'flex', alignItems: 'baseline', gap: '0.75rem', flexWrap: 'wrap',
            }}>
              <span style={{
                background: d.category === 'compliance' ? '#7c2d12' : '#525252',
                color: '#fff', fontSize: 10, padding: '2px 6px', borderRadius: 3, textTransform: 'uppercase',
              }}>{d.category}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#262626' }}>{d.dimension}</span>
              <code style={{ fontSize: 12, color: '#525252' }}>
                {JSON.stringify(Object.fromEntries(Object.entries(d.value).filter(([k]) => k !== 'kind')))}
              </code>
            </div>
          ))}
        </div>
      </section>

      <section style={{ marginBottom: '2.5rem', border: '1px solid #e5e5e5', borderRadius: 6, padding: '1rem' }}>
        <h3 style={{ marginBottom: '0.25rem', fontSize: 14, color: '#525252' }}>Propose a policy change</h3>
        <p style={{ fontSize: 12, color: '#737373', marginBottom: '0.75rem' }}>
          A <strong>tightening</strong> applies immediately (with mandatory backfill). A{' '}
          <strong>relaxation</strong> — anything not provably tighter — requires a second authorized
          approver and cannot be applied from this page. Simulate first to learn the classification.
        </p>
        <form action={proposePolicyAction} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: 560 }}>
          <input type="hidden" name="tenantId" value={tenantId} />
          <label style={{ fontSize: 12, color: '#525252' }}>
            Dimension
            <select name="dimension" defaultValue="classification_exclusions" style={{ display: 'block', marginTop: 2, padding: '0.3rem', fontSize: 13 }}>
              <option value="data_persistence">data_persistence (compliance)</option>
              <option value="indexing_scope">indexing_scope (compliance)</option>
              <option value="connector_enablement">connector_enablement (compliance)</option>
              <option value="operation_permissions">operation_permissions (compliance)</option>
              <option value="data_residency">data_residency (compliance)</option>
              <option value="classification_exclusions">classification_exclusions (compliance)</option>
              <option value="freshness_sla">freshness_sla (operational)</option>
              <option value="retrieval_preference">retrieval_preference (operational)</option>
            </select>
          </label>
          <label style={{ fontSize: 12, color: '#525252' }}>
            Value (JSON body for the dimension, without <code>kind</code>)
            <textarea
              name="value"
              rows={3}
              defaultValue='{"excludeTags": ["Confidential"]}'
              style={{ display: 'block', width: '100%', marginTop: 2, fontFamily: 'monospace', fontSize: 12, padding: '0.4rem' }}
            />
          </label>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="submit" name="mode" value="simulate" style={{ padding: '0.35rem 0.9rem', fontSize: 13 }}>
              Simulate (dry-run)
            </button>
            <button type="submit" name="mode" value="propose" style={{ padding: '0.35rem 0.9rem', fontSize: 13, fontWeight: 600 }}>
              Propose
            </button>
          </div>
        </form>
      </section>

      {/* ── Pending relaxation ballots (dual control, ADR-006 §3.4) ── */}
      <section style={{ marginBottom: '2.5rem', border: '1px solid #e5e5e5', borderRadius: 6, padding: '1rem' }}>
        <h3 style={{ marginBottom: '0.25rem', fontSize: 14, color: '#525252' }}>
          Pending relaxations ({relaxations.length})
        </h3>
        <p style={{ fontSize: 12, color: '#737373', marginBottom: '0.75rem' }}>
          Each vote is cast as <strong>you</strong> — the signed-in principal. The proposer counts as
          at most one vote, so a relaxation applies only when a second authorized approver approves.
          One dissent vetoes.
        </p>
        {relaxationsNote && <p style={{ fontSize: 13, color: '#a16207' }}>{relaxationsNote}</p>}
        {!relaxationsNote && relaxations.length === 0 && (
          <p style={{ color: '#666', fontSize: 13 }}>No relaxation ballots are awaiting approval.</p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {relaxations.map((p) => (
            <div key={p.id} style={{ border: '1px solid #e5e5e5', borderRadius: 6, padding: '0.6rem 1rem' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', flexWrap: 'wrap' }}>
                <span style={{
                  background: '#92400e', color: '#fff', fontSize: 10,
                  padding: '2px 6px', borderRadius: 3, textTransform: 'uppercase',
                }}>pending</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#262626' }}>{p.summary}</span>
                <span style={{ fontSize: 11, color: '#737373' }}>
                  proposed by {p.proposerUserId.slice(0, 8)}… · expires {new Date(p.expiresAt).toLocaleString()}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                <form action={voteRelaxationAction}>
                  <input type="hidden" name="tenantId" value={tenantId} />
                  <input type="hidden" name="proposalId" value={p.id} />
                  <input type="hidden" name="vote" value="approve" />
                  <button type="submit" style={{ padding: '0.3rem 0.8rem', fontSize: 12, fontWeight: 600, color: '#065f46' }}>
                    Approve
                  </button>
                </form>
                <form action={voteRelaxationAction}>
                  <input type="hidden" name="tenantId" value={tenantId} />
                  <input type="hidden" name="proposalId" value={p.id} />
                  <input type="hidden" name="vote" value="reject" />
                  <button type="submit" style={{ padding: '0.3rem 0.8rem', fontSize: 12, color: '#7c2d12' }}>
                    Reject (veto)
                  </button>
                </form>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Rollout plane ── */}
      <section style={{ border: '1px solid #e5e5e5', borderRadius: 6, padding: '1rem' }}>
        <h3 style={{ marginBottom: '0.25rem', fontSize: 14, color: '#525252' }}>Connector rollout</h3>
        <p style={{ fontSize: 12, color: '#737373', marginBottom: '0.75rem' }}>
          Blue/green by job tag: a canary mints new jobs at the target version for the canary cohort;
          rollback re-tags queued jobs to the prior version and never touches leased (in-flight) work.
        </p>
        <form method="get" style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', marginBottom: '1rem' }}>
          <label style={{ fontSize: 12, color: '#525252' }}>
            Connector id
            <input name="connector" defaultValue={connector ?? ''} placeholder="slack" style={{ display: 'block', marginTop: 2, padding: '0.3rem', fontSize: 13 }} />
          </label>
          <button type="submit" style={{ padding: '0.35rem 0.9rem', fontSize: 13 }}>Look up deployment</button>
        </form>

        {deploymentError && <p style={{ color: '#c00', fontSize: 13 }}>Deployment lookup failed: {deploymentError}</p>}

        {deployment && (
          <div style={{ border: '1px solid #e5e5e5', borderRadius: 6, padding: '0.75rem 1rem' }}>
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span style={{
                background: deployment.state === 'stable' ? '#065f46' : deployment.state === 'canary' ? '#92400e' : '#7c2d12',
                color: '#fff', fontSize: 10, padding: '2px 6px', borderRadius: 3, textTransform: 'uppercase',
              }}>{deployment.state}</span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{deployment.connectorId}</span>
              <span style={{ fontSize: 12, color: '#525252' }}>
                active <strong>{deployment.activeVersion}</strong>
                {deployment.targetVersion && <> → target <strong>{deployment.targetVersion}</strong></>}
                {' '}· new jobs mint at <strong>{mintVersion}</strong>
                {' '}· cohort <strong>{deployment.tenantCohort}</strong>
                {deployment.canaryCohort && <> · canary cohort <strong>{deployment.canaryCohort}</strong></>}
              </span>
            </div>

            <div style={{ display: 'flex', gap: '1.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
              <form action={rolloutAction} style={{ display: 'flex', gap: '0.4rem', alignItems: 'flex-end' }}>
                <input type="hidden" name="tenantId" value={tenantId} />
                <input type="hidden" name="connectorId" value={deployment.connectorId} />
                <input type="hidden" name="op" value="canary" />
                <label style={{ fontSize: 11, color: '#525252' }}>
                  target version
                  <input name="targetVersion" placeholder="2.0.0" style={{ display: 'block', marginTop: 2, padding: '0.25rem', fontSize: 12, width: 90 }} />
                </label>
                <label style={{ fontSize: 11, color: '#525252' }}>
                  canary cohort
                  <input name="canaryCohort" defaultValue={deployment.tenantCohort} style={{ display: 'block', marginTop: 2, padding: '0.25rem', fontSize: 12, width: 110 }} />
                </label>
                <button type="submit" style={{ padding: '0.3rem 0.7rem', fontSize: 12 }}>Begin canary</button>
              </form>

              <form action={rolloutAction}>
                <input type="hidden" name="tenantId" value={tenantId} />
                <input type="hidden" name="connectorId" value={deployment.connectorId} />
                <input type="hidden" name="op" value="promote" />
                <button type="submit" style={{ padding: '0.3rem 0.7rem', fontSize: 12 }}>Promote</button>
              </form>

              <form action={rolloutAction}>
                <input type="hidden" name="tenantId" value={tenantId} />
                <input type="hidden" name="connectorId" value={deployment.connectorId} />
                <input type="hidden" name="op" value="rollback" />
                <button type="submit" style={{ padding: '0.3rem 0.7rem', fontSize: 12, color: '#7c2d12' }}>Roll back</button>
              </form>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
