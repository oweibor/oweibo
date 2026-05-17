'use client';

import { useState, useEffect } from 'react';
import { PageHeader } from '@/components/PageHeader';

type Grade = 'red' | 'yellow' | 'green';

interface TaskOutput {
  taskId:       string;
  title:        string;
  axis:         string;
  prompt:       string;
  rubric:       string;
  output:       string;
  synthetic:    boolean;
  existingGrade?: {
    eleganceGrade:   Grade;
    complexityGrade: Grade;
    initiativeGrade: Grade;
    notes?:          string;
  };
}

interface GradeState {
  eleganceGrade:   Grade | '';
  complexityGrade: Grade | '';
  initiativeGrade: Grade | '';
  notes:           string;
}

const GRADE_OPTIONS: Grade[] = ['green', 'yellow', 'red'];

const gradeBg: Record<Grade | '', string> = {
  green:  '#d1fae5',
  yellow: '#fef3c7',
  red:    '#fee2e2',
  '':     '#f5f5f5',
};
const gradeColor: Record<Grade | '', string> = {
  green:  '#065f46',
  yellow: '#92400e',
  red:    '#991b1b',
  '':     '#333',
};

function GradeSelector({
  label, value, onChange,
}: { label: string; value: Grade | ''; onChange: (g: Grade) => void }) {
  return (
    <div style={{ marginBottom: '0.75rem' }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: '0.3rem', color: '#444' }}>{label}</div>
      <div style={{ display: 'flex', gap: '0.4rem' }}>
        {GRADE_OPTIONS.map(g => (
          <button
            key={g}
            onClick={() => onChange(g)}
            style={{
              padding: '0.3rem 0.75rem',
              borderRadius: 4,
              border: value === g ? '2px solid #1a1a1a' : '1px solid #ccc',
              background:   value === g ? gradeBg[g] : '#fff',
              color:        value === g ? gradeColor[g] : '#555',
              fontWeight:   value === g ? 700 : 400,
              cursor: 'pointer',
              fontSize: 13,
              textTransform: 'capitalize',
            }}
          >
            {g}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function EleganceMonthPage({ params }: { params: { month: string } }) {
  const { month } = params;
  const [tasks, setTasks] = useState<TaskOutput[]>([]);
  const [grades, setGrades] = useState<Record<string, GradeState>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/platform/charter/elegance/${month}/outputs`)
      .then(r => r.json())
      .then((data: { tasks: TaskOutput[] }) => {
        setTasks(data.tasks ?? []);
        const initial: Record<string, GradeState> = {};
        for (const t of data.tasks ?? []) {
          initial[t.taskId] = {
            eleganceGrade:   t.existingGrade?.eleganceGrade   ?? '',
            complexityGrade: t.existingGrade?.complexityGrade ?? '',
            initiativeGrade: t.existingGrade?.initiativeGrade ?? '',
            notes:           t.existingGrade?.notes           ?? '',
          };
        }
        setGrades(initial);
        setLoading(false);
      })
      .catch(err => {
        setError(String(err));
        setLoading(false);
      });
  }, [month]);

  function setGrade(taskId: string, field: keyof GradeState, value: string) {
    setGrades(prev => ({
      ...prev,
      [taskId]: { ...(prev[taskId] ?? { eleganceGrade: '', complexityGrade: '', initiativeGrade: '', notes: '' }), [field]: value },
    }));
  }

  async function submitGrade(taskId: string) {
    const g = grades[taskId];
    if (!g?.eleganceGrade || !g.complexityGrade || !g.initiativeGrade) {
      alert('Please select a grade for all three axes before submitting.');
      return;
    }
    setSaving(taskId);
    try {
      const res = await fetch(`/api/platform/charter/elegance/${month}/grade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, ...g }),
      });
      if (!res.ok) throw new Error(await res.text());
      setSaved(prev => new Set([...prev, taskId]));
    } catch (err) {
      alert(`Failed to save grade: ${String(err)}`);
    } finally {
      setSaving(null);
    }
  }

  if (loading) return <p style={{ padding: '2rem' }}>Loading battery outputs...</p>;
  if (error)   return <p style={{ padding: '2rem', color: '#c00' }}>Error: {error}</p>;

  const gradedCount = [...Object.values(grades)].filter(
    g => g.eleganceGrade && g.complexityGrade && g.initiativeGrade,
  ).length;

  return (
    <>
      <PageHeader
        title={`Elegance Battery — ${month}`}
        subtitle={`${gradedCount} / ${tasks.length} tasks graded`}
      />

      <p style={{ color: '#555', fontSize: 13, marginBottom: '1.5rem' }}>
        Grade each task on elegance, unnecessary complexity, and initiative quality.
        Hallucination and strategic tasks are included under the same rubric.
        Red grades or two consecutive yellows on the same axis auto-escalate to the charter spot-audit queue.
      </p>

      {tasks.map(task => {
        const g = grades[task.taskId] ?? { eleganceGrade: '', complexityGrade: '', initiativeGrade: '', notes: '' };
        const isSaved  = saved.has(task.taskId) || !!task.existingGrade;
        const isSaving = saving === task.taskId;

        return (
          <div
            key={task.taskId}
            style={{
              border: '1px solid #e5e5e5',
              borderRadius: 8,
              padding: '1.25rem',
              marginBottom: '1.5rem',
              background: isSaved ? '#f9fafb' : '#fff',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <div>
                <span style={{ fontWeight: 700, fontSize: 15 }}>{task.taskId}</span>
                <span style={{ fontSize: 12, color: '#666', marginLeft: '0.75rem', textTransform: 'capitalize' }}>
                  [{task.axis}]
                </span>
                <span style={{ fontSize: 14, marginLeft: '0.5rem' }}>{task.title}</span>
              </div>
              {task.synthetic && (
                <span style={{ fontSize: 11, background: '#fef3c7', color: '#92400e', padding: '2px 6px', borderRadius: 4 }}>
                  synthetic
                </span>
              )}
            </div>

            <details style={{ marginBottom: '0.75rem' }}>
              <summary style={{ fontSize: 13, color: '#555', cursor: 'pointer' }}>Task prompt + rubric</summary>
              <pre style={{ fontSize: 12, background: '#f5f5f5', padding: '0.75rem', borderRadius: 4, whiteSpace: 'pre-wrap', marginTop: '0.5rem' }}>
                {task.prompt}
              </pre>
              <pre style={{ fontSize: 12, background: '#eff6ff', padding: '0.75rem', borderRadius: 4, whiteSpace: 'pre-wrap', marginTop: '0.5rem', borderLeft: '3px solid #3b82f6' }}>
                Rubric: {task.rubric}
              </pre>
            </details>

            <div style={{ background: '#f9fafb', border: '1px solid #e5e5e5', borderRadius: 4, padding: '0.75rem', marginBottom: '0.75rem' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#444', marginBottom: '0.4rem' }}>Agent output</div>
              <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', margin: 0 }}>{task.output}</pre>
            </div>

            <GradeSelector
              label="Elegance (conciseness vs. baseline)"
              value={g.eleganceGrade}
              onChange={v => setGrade(task.taskId, 'eleganceGrade', v)}
            />
            <GradeSelector
              label="Unnecessary complexity (steps that did not need to exist)"
              value={g.complexityGrade}
              onChange={v => setGrade(task.taskId, 'complexityGrade', v)}
            />
            <GradeSelector
              label="Initiative quality (actions added value vs. busywork)"
              value={g.initiativeGrade}
              onChange={v => setGrade(task.taskId, 'initiativeGrade', v)}
            />

            <div style={{ marginBottom: '0.75rem' }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: '0.3rem', color: '#444' }}>Notes (optional)</div>
              <textarea
                value={g.notes}
                onChange={e => setGrade(task.taskId, 'notes', e.target.value)}
                rows={2}
                style={{ width: '100%', fontSize: 13, padding: '0.4rem', border: '1px solid #ccc', borderRadius: 4, resize: 'vertical' }}
              />
            </div>

            <button
              onClick={() => submitGrade(task.taskId)}
              disabled={isSaving}
              style={{
                padding: '0.4rem 1rem',
                background: isSaved ? '#d1fae5' : '#1a1a1a',
                color:      isSaved ? '#065f46' : '#fff',
                border: 'none', borderRadius: 4, cursor: isSaving ? 'wait' : 'pointer', fontSize: 14,
              }}
            >
              {isSaving ? 'Saving...' : isSaved ? '✓ Saved' : 'Submit grade'}
            </button>
          </div>
        );
      })}
    </>
  );
}
