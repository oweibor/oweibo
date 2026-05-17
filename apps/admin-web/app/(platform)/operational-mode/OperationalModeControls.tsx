'use client';

import { useState } from 'react';

interface Props {
  currentMode: number;
  modeNames:   Record<number, string>;
}

const DANGER_MODES = new Set([0, 1]);

export function OperationalModeControls({ currentMode, modeNames }: Props) {
  const [selectedMode, setSelectedMode] = useState<number>(currentMode);
  const [reason, setReason]             = useState('');
  const [submitting, setSubmitting]     = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [success, setSuccess]           = useState<string | null>(null);

  const unchanged = selectedMode === currentMode;
  const isDanger  = DANGER_MODES.has(selectedMode);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (unchanged || !reason.trim()) return;

    if (isDanger) {
      const confirmed = window.confirm(
        `Setting mode ${selectedMode} (${modeNames[selectedMode] ?? ''}) will stop critical platform functions. Confirm?`,
      );
      if (!confirmed) return;
    }

    setSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch('/api/platform/operational-mode', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ mode: selectedMode, reason: reason.trim() }),
      });
      const data = await res.json() as { error?: string; mode?: number };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
      } else {
        setSuccess(`Mode set to ${selectedMode} — ${modeNames[selectedMode] ?? ''}`);
        setReason('');
        // Reload to show updated state from server
        window.location.reload();
      }
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ marginBottom: '2rem' }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: '0.75rem' }}>Change mode</h2>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: 480 }}>
        <div>
          <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: '0.3rem' }}>
            Target mode
          </label>
          <select
            value={selectedMode}
            onChange={e => setSelectedMode(Number(e.target.value))}
            style={{
              width: '100%', padding: '0.5rem 0.75rem', fontSize: 14,
              border: '1px solid #ccc', borderRadius: 4, background: '#fff',
            }}
          >
            {([5, 4, 3, 2, 1, 0] as const).map(m => (
              <option key={m} value={m}>{m} — {modeNames[m] ?? ''}</option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: '0.3rem' }}>
            Reason <span style={{ color: '#c00' }}>*</span>
          </label>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Describe why this mode change is needed…"
            rows={3}
            style={{
              width: '100%', padding: '0.5rem 0.75rem', fontSize: 14,
              border: '1px solid #ccc', borderRadius: 4, resize: 'vertical', boxSizing: 'border-box',
            }}
          />
        </div>

        {isDanger && !unchanged && (
          <div style={{
            padding: '0.6rem 0.9rem', background: '#fee2e2', border: '1px solid #fca5a5',
            borderRadius: 4, fontSize: 13, color: '#991b1b',
          }}>
            Mode {selectedMode} is a restricted mode. Recovery from mode ≤ 1 requires human intervention.
          </div>
        )}

        {error && (
          <p style={{ color: '#c00', fontSize: 13, margin: 0 }}>{error}</p>
        )}
        {success && (
          <p style={{ color: '#065f46', fontSize: 13, margin: 0 }}>{success}</p>
        )}

        <button
          type="submit"
          disabled={unchanged || !reason.trim() || submitting}
          style={{
            alignSelf: 'flex-start',
            padding: '0.5rem 1.25rem',
            fontSize: 14, fontWeight: 600,
            background: unchanged || !reason.trim() ? '#e5e5e5' : isDanger ? '#dc2626' : '#1a1a1a',
            color: unchanged || !reason.trim() ? '#999' : '#fff',
            border: 'none', borderRadius: 4, cursor: unchanged || !reason.trim() ? 'not-allowed' : 'pointer',
          }}
        >
          {submitting ? 'Applying…' : `Set mode ${selectedMode}`}
        </button>
      </form>
    </div>
  );
}
