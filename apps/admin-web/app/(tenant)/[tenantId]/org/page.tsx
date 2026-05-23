import type { Metadata } from 'next';
import { identityApi } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Org graph' };

interface OrgNode {
  id: string;
  tenantId: string;
  nodeType: 'person' | 'team' | 'system' | 'decision_body' | 'external_party';
  label: string;
  userId: string | null;
  externalRef: string | null;
}

interface OrgEdge {
  id: string;
  fromNode: string;
  toNode: string;
  edgeType: 'reports_to' | 'owns' | 'approves' | 'depends_on' | 'member_of' | 'accountable_for';
  metadata?: Record<string, unknown>;
}

interface OrgGraphResponse {
  nodes: OrgNode[];
  edges: OrgEdge[];
}

const NODE_COLOR: Record<OrgNode['nodeType'], string> = {
  person: '#1e3a8a',
  team: '#065f46',
  system: '#525252',
  decision_body: '#7c2d12',
  external_party: '#92400e',
};

export default async function OrgPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;

  let graph: OrgGraphResponse = { nodes: [], edges: [] };
  let fetchError: string | null = null;
  try {
    graph = await identityApi.get<OrgGraphResponse>(`/api/v1/tenants/${tenantId}/org`);
  } catch (err: any) {
    fetchError = err.message;
  }

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  return (
    <>
      <PageHeader
        title="Org graph"
        subtitle={`${graph.nodes.length} node${graph.nodes.length !== 1 ? 's' : ''} · ${graph.edges.length} edge${graph.edges.length !== 1 ? 's' : ''}`}
      />
      {fetchError && <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>}
      {graph.nodes.length === 0 && !fetchError && (
        <p style={{ color: '#666', fontSize: 14 }}>
          Org graph is empty. The seeder installs the minimal day-one structure
          when <code>tenant.bootstrap.org_graph.enabled</code> is on and the
          worker pipeline runs against this tenant.
        </p>
      )}

      <h3 style={{ fontSize: 14, marginTop: '1.5rem', marginBottom: '0.5rem' }}>Nodes</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        {graph.nodes.map((n) => (
          <div key={n.id} style={{
            display: 'grid', gridTemplateColumns: '120px 1fr auto', gap: '0.75rem',
            border: '1px solid #eee', borderRadius: 4, padding: '0.5rem 0.85rem', alignItems: 'center',
          }}>
            <span style={{
              background: NODE_COLOR[n.nodeType], color: '#fff', fontSize: 10,
              padding: '2px 6px', borderRadius: 3, textAlign: 'center',
            }}>{n.nodeType}</span>
            <span style={{ fontSize: 13 }}>{n.label}</span>
            <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#888' }}>
              {n.id.slice(0, 8)}
              {n.externalRef && ` · ${n.externalRef}`}
            </span>
          </div>
        ))}
      </div>

      {graph.edges.length > 0 && (
        <>
          <h3 style={{ fontSize: 14, marginTop: '1.5rem', marginBottom: '0.5rem' }}>Edges</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            {graph.edges.map((e) => {
              const from = nodeById.get(e.fromNode);
              const to = nodeById.get(e.toNode);
              const classes = (e.metadata as { actionClasses?: string[] } | undefined)?.actionClasses;
              return (
                <div key={e.id} style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem',
                  fontSize: 12, color: '#333',
                }}>
                  <span>{from?.label ?? e.fromNode.slice(0, 8)}</span>
                  <span style={{
                    background: '#374151', color: '#fff', fontSize: 10,
                    padding: '1px 6px', borderRadius: 3,
                  }}>{e.edgeType}</span>
                  <span>{to?.label ?? e.toNode.slice(0, 8)}</span>
                  {classes && (
                    <span style={{ fontSize: 11, color: '#888', marginLeft: 'auto' }}>
                      {classes.length} action class{classes.length !== 1 ? 'es' : ''}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
