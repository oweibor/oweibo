import type { Metadata } from 'next';
import Link from 'next/link';
import { pipelineApi } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Tasks' };

export default async function TasksPage({ params, searchParams }: {
  params:       Promise<{ tenantId: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { tenantId }  = await params;
  const { status }    = await searchParams;
  const qs = status ? `?status=${encodeURIComponent(status)}&limit=50` : '?limit=50';

  let tasks: any[] = [];
  let count  = 0;
  let fetchError: string | null = null;
  try {
    const result = await pipelineApi.get<{ tasks: any[]; count: number }>(`/tasks${qs}`);
    tasks = result.tasks ?? [];
    count = result.count ?? tasks.length;
  } catch (err: any) {
    fetchError = err.message;
  }

  const statusOptions = ['', 'pending', 'running', 'completed', 'failed'];
  const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
    pending:   { bg: '#fef9c3', fg: '#854d0e' },
    running:   { bg: '#dbeafe', fg: '#1e40af' },
    completed: { bg: '#d1fae5', fg: '#065f46' },
    failed:    { bg: '#fee2e2', fg: '#991b1b' },
  };

  return (
    <>
      <PageHeader title="Tasks" subtitle={`${count} total`} />

      <div style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        {statusOptions.map(s => (
          <Link
            key={s || 'all'}
            href={s ? `/t/${tenantId}/tasks?status=${s}` : `/t/${tenantId}/tasks`}
            style={{
              padding: '0.25rem 0.75rem', fontSize: 13, borderRadius: 999,
              textDecoration: 'none',
              background: status === s || (!status && !s) ? '#1a1a1a' : '#f0f0f0',
              color:      status === s || (!status && !s) ? '#fff'    : '#333',
            }}
          >
            {s || 'All'}
          </Link>
        ))}
      </div>

      {fetchError && <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>}
      {tasks.length === 0 && !fetchError && <p>No tasks.</p>}

      {tasks.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e5e5', textAlign: 'left' }}>
              <th style={{ padding: '0.5rem 0.75rem' }}>Task ID</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Status</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Created</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t: any) => {
              const id     = t.taskId ?? t.id;
              const sc     = STATUS_COLORS[t.status] ?? { bg: '#f0f0f0', fg: '#333' };
              return (
                <tr key={id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={{ padding: '0.5rem 0.75rem', fontFamily: 'monospace', fontSize: 12 }}>{id}</td>
                  <td style={{ padding: '0.5rem 0.75rem' }}>
                    <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 12, background: sc.bg, color: sc.fg }}>
                      {t.status}
                    </span>
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem', color: '#888' }}>
                    {t.createdAt ? new Date(t.createdAt).toLocaleString() : '—'}
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
