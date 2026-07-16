/**
 * F.4.8 / F.4.5: compliance evaluations + cache refresh page.
 *
 *   GET  /tenants/:tenantId/domains/compliance/evaluations?verdict=…
 *   POST /tenants/:tenantId/domains/compliance/refresh
 *
 * Shows the most recent noteworthy compliance verdicts (info / warn /
 * block / bypass). A refresh button invalidates the per-tenant binding
 * lookup cache so the next gate call re-reads from the DB instead of
 * waiting for the 60s TTL to expire.
 *
 * Verdict filter rides a `?verdict=` search param (multiple values
 * comma-separated). Default surfaces info/warn/block/bypass.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { pipelineApi } from '@/lib/api';
import { getSessionToken } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Compliance evaluations' };

type Verdict = 'pass' | 'info' | 'warn' | 'block' | 'bypass';
type Phase = 'action_time' | 'artifact_time';

interface EvaluationRow {
  id: string;
  proposalId: string | null;
  ruleId: string;
  domainSlug: string | null;
  packVersion: string;
  enforcementPhase: Phase;
  verdict: Verdict;
  details: Record<string, unknown>;
  bypassPrincipal: string | null;
  bypassReason: string | null;
  evaluatedAt: string;
}

async function refreshCacheAction(formData: FormData): Promise<void> {
  'use server';
  const tenantId = formData.get('tenantId') as string;
  const token = await getSessionToken();
  const PIPELINE_URL = process.env['PIPELINE_URL'] ?? 'http://localhost:3100/api/v1';
  const res = await fetch(`${PIPELINE_URL}/tenants/${tenantId}/domains/compliance/refresh`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`refreshCache failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  redirect(`/t/${tenantId}/domains/compliance`);
}

export default async function CompliancePage({
  params, searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ verdict?: string; limit?: string; cursor?: string }>;
}) {
  const { tenantId } = await params;
  const { verdict: verdictParam, limit: limitParam, cursor: cursorParam } = await searchParams;

  // Parse comma-separated verdicts: ?verdict=warn,block → ["warn", "block"].
  const verdictFilter = verdictParam
    ? verdictParam.split(',').map((v) => v.trim()).filter(Boolean)
    : [];
  const limit = limitParam && /^\d+$/.test(limitParam) ? parseInt(limitParam, 10) : 50;

  let evaluations: EvaluationRow[] = [];
  let nextCursor: string | null = null;
  let fetchError: string | null = null;
  try {
    const query = new URLSearchParams();
    for (const v of verdictFilter) query.append('verdict', v);
    query.set('limit', String(limit));
    // F.7 review (M7): propagate the cursor so the "Older evaluations" link
    // actually advances; the prior code rebuilt the URL without it and
    // re-fetched page 1 on every "Older" click.
    if (cursorParam) query.set('cursor', cursorParam);
    const res = await pipelineApi.get<{ evaluations: EvaluationRow[]; nextCursor: string | null }>(
      `/tenants/${tenantId}/domains/compliance/evaluations?${query.toString()}`,
    );
    evaluations = res.evaluations ?? [];
    nextCursor = res.nextCursor;
  } catch (err: unknown) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  return (
    <>
      <PageHeader
        title="Compliance evaluations"
        subtitle="Recent noteworthy rule outcomes from the domain rule packs"
        actions={
          <form action={refreshCacheAction} style={{ margin: 0 }}>
            <input type="hidden" name="tenantId" value={tenantId} />
            <button type="submit" style={{
              padding: '0.4rem 0.85rem',
              background: '#fff', color: '#1e3a8a',
              border: '1px solid #1e3a8a', borderRadius: 4,
              cursor: 'pointer', fontSize: 12,
            }}>
              Refresh binding cache
            </button>
          </form>
        }
      />

      <VerdictFilter tenantId={tenantId} active={verdictFilter} />

      {fetchError && (
        <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>
      )}

      {evaluations.length === 0 && !fetchError && (
        <p style={{ color: '#666', fontSize: 13 }}>
          No recent evaluations match the current filter. Compliance rule
          packs only fire against bound domains — confirm bindings exist in{' '}
          <Link href={`/t/${tenantId}/domains?tab=bindings`} style={{ color: '#1e3a8a' }}>
            Domains → Bindings
          </Link>.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {evaluations.map((e) => (
          <EvaluationCard key={e.id} row={e} />
        ))}
      </div>

      {nextCursor && (
        <Link
          href={`/t/${tenantId}/domains/compliance?${new URLSearchParams({
            ...(verdictFilter.length > 0 ? { verdict: verdictFilter.join(',') } : {}),
            limit: String(limit),
            cursor: nextCursor,
          }).toString()}`}
          style={{
            display: 'inline-block', marginTop: '1rem', color: '#1e3a8a',
            fontSize: 13, textDecoration: 'underline',
          }}
        >
          Older evaluations →
        </Link>
      )}
    </>
  );
}

function VerdictFilter({
  tenantId, active,
}: { tenantId: string; active: string[] }) {
  const all: { id: Verdict; label: string }[] = [
    { id: 'info',   label: 'info' },
    { id: 'warn',   label: 'warn' },
    { id: 'block',  label: 'block' },
    { id: 'bypass', label: 'bypass' },
  ];
  const set = new Set(active);
  return (
    <div style={{
      display: 'flex', gap: '0.5rem', marginBottom: '1rem',
      flexWrap: 'wrap', alignItems: 'center',
    }}>
      <span style={{ fontSize: 12, color: '#888' }}>Filter:</span>
      <Link
        href={`/t/${tenantId}/domains/compliance`}
        style={chipStyle(set.size === 0)}
      >
        all noteworthy
      </Link>
      {all.map((v) => {
        const next = new Set(set);
        if (next.has(v.id)) next.delete(v.id);
        else next.add(v.id);
        const q = next.size > 0
          ? `?verdict=${Array.from(next).join(',')}`
          : '';
        return (
          <Link
            key={v.id}
            href={`/t/${tenantId}/domains/compliance${q}`}
            style={chipStyle(set.has(v.id))}
          >
            {v.label}
          </Link>
        );
      })}
    </div>
  );
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: '0.25rem 0.7rem', borderRadius: 12,
    border: `1px solid ${active ? '#1e3a8a' : '#ccc'}`,
    background: active ? '#1e3a8a' : '#fff',
    color: active ? '#fff' : '#525252',
    textDecoration: 'none', fontSize: 12,
  };
}

function EvaluationCard({ row }: { row: EvaluationRow }) {
  return (
    <div style={{
      border: '1px solid #e5e5e5', borderRadius: 6,
      padding: '0.65rem 1rem',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem' }}>
        <span style={verdictBadge(row.verdict)}>{row.verdict}</span>
        <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{row.ruleId}</span>
        {row.domainSlug && (
          <span style={{ fontSize: 11, color: '#888' }}>
            {row.domainSlug} @ {row.packVersion}
          </span>
        )}
        <span style={{ fontSize: 11, color: '#888' }}>{row.enforcementPhase}</span>
        <span style={{ fontSize: 11, color: '#888', marginLeft: 'auto' }}>
          {new Date(row.evaluatedAt).toLocaleString()}
        </span>
      </div>
      {row.proposalId && (
        <div style={{ marginTop: 4, fontSize: 11, color: '#888' }}>
          proposal: <code>{row.proposalId.slice(0, 8)}…</code>
        </div>
      )}
      {row.bypassPrincipal && (
        <div style={{ marginTop: 4, fontSize: 11, color: '#7c2d12' }}>
          bypass by <code>{row.bypassPrincipal}</code>
          {row.bypassReason && `: ${row.bypassReason}`}
        </div>
      )}
      {Object.keys(row.details).length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ fontSize: 11, color: '#525252', cursor: 'pointer' }}>
            details
          </summary>
          <pre style={{
            marginTop: 4, padding: '0.4rem', background: '#fafafa',
            border: '1px solid #f0f0f0', borderRadius: 4,
            fontSize: 11, overflowX: 'auto',
          }}>{JSON.stringify(row.details, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

function verdictBadge(v: Verdict): React.CSSProperties {
  const colorMap: Record<Verdict, string> = {
    pass: '#065f46',
    info: '#525252',
    warn: '#92400e',
    block: '#991b1b',
    bypass: '#7c2d12',
  };
  return {
    background: colorMap[v], color: '#fff', fontSize: 10,
    padding: '2px 6px', borderRadius: 3, textTransform: 'uppercase',
  };
}
