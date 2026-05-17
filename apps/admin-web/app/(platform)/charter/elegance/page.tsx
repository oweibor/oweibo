import type { Metadata } from 'next';
import Link from 'next/link';
import { requireScope } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';
import { pipelineApi } from '@/lib/api';

export const metadata: Metadata = { title: 'Elegance Battery' };

interface MonthSummary {
  runMonth:        string;
  totalGraded:     number;
  redCount:        number;
  yellowCount:     number;
  greenCount:      number;
  escalationCount: number;
}

export default async function EleganceBatteryPage() {
  await requireScope('platform:charter:read');

  let months: MonthSummary[] = [];
  let fetchError: string | null = null;

  try {
    const result = await pipelineApi.get<{ months: MonthSummary[] }>('/charter/elegance/months');
    months = result.months ?? [];
  } catch (err: unknown) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  const gradeColor = (n: number, type: 'red' | 'yellow' | 'green') => {
    if (n === 0) return '#666';
    return type === 'red' ? '#991b1b' : type === 'yellow' ? '#92400e' : '#065f46';
  };

  return (
    <>
      <PageHeader
        title="Monthly Elegance Battery"
        subtitle="Human-judgement anti-Goodhart layer (§18.9)"
        actions={
          <Link href="/platform/charter/elegance/run" style={{
            padding: '0.4rem 0.9rem', background: '#1a1a1a', color: '#fff',
            textDecoration: 'none', fontSize: 14, borderRadius: 4,
          }}>
            Start this month
          </Link>
        }
      />

      <p style={{ color: '#555', fontSize: 14, marginBottom: '1.5rem' }}>
        Monthly battery of 15 fixed tasks graded by a platform reviewer on five axes:
        elegance, complexity, initiative, hallucination, and strategic reasoning.
        Any red grade or two consecutive yellows on the same axis triggers a charter spot-audit.
      </p>

      {fetchError && <p style={{ color: '#c00' }}>Failed to load results: {fetchError}</p>}

      {months.length === 0 && !fetchError && (
        <p style={{ color: '#666' }}>No battery runs yet. Click "Start this month" to begin.</p>
      )}

      {months.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e5e5', textAlign: 'left' }}>
              <th style={{ padding: '0.5rem 0.75rem' }}>Month</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Graded</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Red</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Yellow</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Green</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Escalations</th>
              <th style={{ padding: '0.5rem 0.75rem' }}></th>
            </tr>
          </thead>
          <tbody>
            {months.map(m => (
              <tr key={m.runMonth} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={{ padding: '0.5rem 0.75rem', fontWeight: 500 }}>{m.runMonth}</td>
                <td style={{ padding: '0.5rem 0.75rem' }}>{m.totalGraded} / 15</td>
                <td style={{ padding: '0.5rem 0.75rem', color: gradeColor(m.redCount, 'red'), fontWeight: m.redCount > 0 ? 700 : 400 }}>
                  {m.redCount}
                </td>
                <td style={{ padding: '0.5rem 0.75rem', color: gradeColor(m.yellowCount, 'yellow') }}>
                  {m.yellowCount}
                </td>
                <td style={{ padding: '0.5rem 0.75rem', color: gradeColor(m.greenCount, 'green') }}>
                  {m.greenCount}
                </td>
                <td style={{ padding: '0.5rem 0.75rem' }}>
                  {m.escalationCount > 0 ? (
                    <span style={{ color: '#991b1b', fontWeight: 600 }}>
                      ⚠ {m.escalationCount}
                    </span>
                  ) : (
                    <span style={{ color: '#065f46' }}>none</span>
                  )}
                </td>
                <td style={{ padding: '0.5rem 0.75rem' }}>
                  <Link href={`/platform/charter/elegance/${m.runMonth}`} style={{ fontSize: 12, color: '#555' }}>
                    Review →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
