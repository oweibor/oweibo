'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  tenantId:          string;
  currentChannel:    string;
  availableChannels: string[];
}

const RISKY_CHANNELS = new Set(['fast', 'beta']);

export function TenantCohortControls({ tenantId, currentChannel, availableChannels }: Props) {
  const router = useRouter();
  const [target, setTarget]         = useState(currentChannel);
  const [reason, setReason]         = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [open, setOpen]             = useState(false);

  const unchanged = target === currentChannel;
  const reasonOK  = reason.trim().length >= 3;
  const isRisky   = RISKY_CHANNELS.has(target);
  const canSubmit = !unchanged && reasonOK;

  async function submit() {
    if (!canSubmit) return;
    if (isRisky) {
      const ok = window.confirm(
        `Switch this tenant to '${target}' cohort? They'll be exposed to bandit-explored prompts on the next task.`,
      );
      if (!ok) return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/platform/cohorts/tenants/${encodeURIComponent(tenantId)}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ newChannel: target, reason: reason.trim() }),
      });
      const data = await res.json() as { error?: string; message?: string };
      if (!res.ok) {
        setError(data.message ?? data.error ?? `HTTP ${res.status}`);
        setSubmitting(false);
        return;
      }
      router.refresh();
    } catch (err: unknown) {
      setError(String(err));
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          padding: '0.3rem 0.7rem', fontSize: 12, fontWeight: 500,
          background: '#fff', color: '#333', border: '1px solid #d1d5db',
          borderRadius: 4, cursor: 'pointer',
        }}
      >
        Change…
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      <select
        value={target}
        onChange={e => setTarget(e.target.value)}
        disabled={submitting}
        style={{ padding: '0.3rem', fontSize: 12, border: '1px solid #d1d5db', borderRadius: 4 }}
      >
        {availableChannels.map(c => (
          <option key={c} value={c}>{c}{c === currentChannel ? ' (current)' : ''}</option>
        ))}
      </select>
      <input
        type="text"
        value={reason}
        onChange={e => setReason(e.target.value)}
        placeholder="Reason (audited)"
        disabled={submitting}
        style={{ padding: '0.3rem 0.5rem', fontSize: 12, border: '1px solid #d1d5db', borderRadius: 4 }}
      />
      {error && <p style={{ color: '#c00', fontSize: 11, margin: 0 }}>{error}</p>}
      <div style={{ display: 'flex', gap: '0.4rem' }}>
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit || submitting}
          style={{
            flex: 1, padding: '0.3rem 0.5rem', fontSize: 12, fontWeight: 600,
            background: canSubmit && !submitting ? (isRisky ? '#dc2626' : '#1a1a1a') : '#e5e7eb',
            color:      canSubmit && !submitting ? '#fff'    : '#9ca3af',
            border: 'none', borderRadius: 4,
            cursor: canSubmit && !submitting ? 'pointer' : 'not-allowed',
          }}
        >
          {submitting ? 'Saving…' : 'Apply'}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setReason(''); setError(null); setTarget(currentChannel); }}
          disabled={submitting}
          style={{
            padding: '0.3rem 0.5rem', fontSize: 12,
            background: '#fff', color: '#666',
            border: '1px solid #d1d5db', borderRadius: 4, cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
