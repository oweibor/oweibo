'use client';

import { useState } from 'react';

interface ThresholdConfig {
  threshold_7d:    number;
  threshold_30d:   number;
  threshold_90d:   number;
  threshold_vs_v0: number;
}

interface Props {
  currentConfig: ThresholdConfig;
}

export function ThresholdControls({ currentConfig }: Props) {
  const [values, setValues] = useState({
    threshold_7d:    currentConfig.threshold_7d,
    threshold_30d:   currentConfig.threshold_30d,
    threshold_90d:   currentConfig.threshold_90d,
    threshold_vs_v0: currentConfig.threshold_vs_v0,
  });
  const [reason, setReason]       = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [success, setSuccess]     = useState<string | null>(null);

  const labels: Record<keyof typeof values, string> = {
    threshold_7d:    '7-day rolling threshold',
    threshold_30d:   '30-day rolling threshold',
    threshold_90d:   '90-day rolling threshold',
    threshold_vs_v0: 'vs stable-v0 threshold',
  };

  const unchanged =
    values.threshold_7d    === currentConfig.threshold_7d    &&
    values.threshold_30d   === currentConfig.threshold_30d   &&
    values.threshold_90d   === currentConfig.threshold_90d   &&
    values.threshold_vs_v0 === currentConfig.threshold_vs_v0;

  function handleChange(key: keyof typeof values, raw: string) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n > 0 && n < 1) setValues(v => ({ ...v, [key]: n }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (unchanged || !reason.trim()) return;

    setSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch('/api/platform/charter/thresholds', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ...values, reason: reason.trim() }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
      } else {
        setSuccess('Thresholds updated successfully.');
        setReason('');
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
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: '0.75rem' }}>Update thresholds</h2>
      <p style={{ fontSize: 13, color: '#666', marginBottom: '1rem' }}>
        Requires <code>platform:admin</code> scope. Changes are audit-logged.
      </p>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: 400 }}>
        {(Object.keys(labels) as Array<keyof typeof values>).map(key => (
          <div key={key}>
            <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: '0.25rem' }}>
              {labels[key]}
            </label>
            <input
              type="number"
              min={0.01}
              max={0.99}
              step={0.01}
              value={values[key]}
              onChange={e => handleChange(key, e.target.value)}
              style={{
                width: 100, padding: '0.4rem 0.6rem', fontSize: 14,
                border: '1px solid #ccc', borderRadius: 4, fontFamily: 'monospace',
              }}
            />
          </div>
        ))}

        <div>
          <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: '0.25rem' }}>
            Reason <span style={{ color: '#c00' }}>*</span>
          </label>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Describe why these thresholds are being changed…"
            rows={2}
            style={{
              width: '100%', padding: '0.5rem 0.75rem', fontSize: 14,
              border: '1px solid #ccc', borderRadius: 4, resize: 'vertical', boxSizing: 'border-box',
            }}
          />
        </div>

        {error   && <p style={{ color: '#c00', fontSize: 13, margin: 0 }}>{error}</p>}
        {success && <p style={{ color: '#065f46', fontSize: 13, margin: 0 }}>{success}</p>}

        <button
          type="submit"
          disabled={unchanged || !reason.trim() || submitting}
          style={{
            alignSelf: 'flex-start',
            padding: '0.5rem 1.25rem',
            fontSize: 14, fontWeight: 600,
            background: unchanged || !reason.trim() ? '#e5e5e5' : '#1a1a1a',
            color:      unchanged || !reason.trim() ? '#999' : '#fff',
            border: 'none', borderRadius: 4,
            cursor: unchanged || !reason.trim() ? 'not-allowed' : 'pointer',
          }}
        >
          {submitting ? 'Saving…' : 'Save thresholds'}
        </button>
      </form>
    </div>
  );
}
