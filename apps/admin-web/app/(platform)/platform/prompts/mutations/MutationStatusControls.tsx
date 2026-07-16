'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { MutationStatus } from './page';

interface ControlsProps {
  slotId:        string;
  role:          string;
  currentStatus: MutationStatus;
}

const STATUS_LABELS: Record<MutationStatus, string> = {
  mutable: 'Unfreeze (mutable)',
  guarded: 'Guard',
  frozen:  'Freeze',
};

export function MutationStatusControls({ slotId, role, currentStatus }: ControlsProps) {
  const router = useRouter();
  const [target, setTarget]         = useState<MutationStatus>(currentStatus);
  const [reason, setReason]         = useState('');
  const [rfcUrl, setRfcUrl]         = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [open,  setOpen]            = useState(false);

  const unchanged   = target === currentStatus;
  const reasonOK    = reason.trim().length >= 3;
  const rfcRequired = target === 'frozen';
  const rfcOK       = !rfcRequired || /^https?:\/\//.test(rfcUrl.trim());
  const canSubmit   = !unchanged && reasonOK && rfcOK;

  async function submit() {
    if (!canSubmit) return;
    if (target === 'frozen') {
      const ok = window.confirm(
        `Freeze ${role}/${slotId}? GEPA will stop producing candidates for this slot until it's unfrozen.`,
      );
      if (!ok) return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/platform/prompts/mutations', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          slotId, role, newStatus: target, reason: reason.trim(),
          ...(rfcRequired ? { rfcUrl: rfcUrl.trim() } : {}),
        }),
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
        onChange={e => setTarget(e.target.value as MutationStatus)}
        disabled={submitting}
        style={{ padding: '0.3rem', fontSize: 12, border: '1px solid #d1d5db', borderRadius: 4 }}
      >
        {(['mutable', 'guarded', 'frozen'] as const).map(s => (
          <option key={s} value={s}>{STATUS_LABELS[s]}</option>
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
      {rfcRequired && (
        <input
          type="url"
          value={rfcUrl}
          onChange={e => setRfcUrl(e.target.value)}
          placeholder="RFC URL (required for freeze)"
          disabled={submitting}
          style={{ padding: '0.3rem 0.5rem', fontSize: 12, border: '1px solid #d1d5db', borderRadius: 4 }}
        />
      )}
      {error && <p style={{ color: '#c00', fontSize: 11, margin: 0 }}>{error}</p>}
      <div style={{ display: 'flex', gap: '0.4rem' }}>
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit || submitting}
          style={{
            flex: 1, padding: '0.3rem 0.5rem', fontSize: 12, fontWeight: 600,
            background: canSubmit && !submitting ? '#1a1a1a' : '#e5e7eb',
            color:      canSubmit && !submitting ? '#fff'    : '#9ca3af',
            border: 'none', borderRadius: 4,
            cursor: canSubmit && !submitting ? 'pointer' : 'not-allowed',
          }}
        >
          {submitting ? 'Saving…' : 'Apply'}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setReason(''); setRfcUrl(''); setError(null); }}
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

// ── Filter bar ────────────────────────────────────────────────────────────────

interface FilterProps {
  initialRole:   string;
  initialStatus: string;
}

export function MutationFilters({ initialRole, initialStatus }: FilterProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [role, setRole]     = useState(initialRole);
  const [status, setStatus] = useState(initialStatus);

  function apply() {
    const params = new URLSearchParams(searchParams.toString());
    if (role)   params.set('role',   role);   else params.delete('role');
    if (status) params.set('status', status); else params.delete('status');
    router.push(`/platform/prompts/mutations${params.toString() ? '?' + params.toString() : ''}`);
  }

  function clear() {
    setRole(''); setStatus('');
    router.push('/platform/prompts/mutations');
  }

  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '1rem', fontSize: 13 }}>
      <span style={{ color: '#555' }}>Filter:</span>
      <select
        value={role}
        onChange={e => setRole(e.target.value)}
        style={{ padding: '0.3rem 0.5rem', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 4 }}
      >
        <option value="">all roles</option>
        <option value="architect">architect</option>
        <option value="executor">executor</option>
        <option value="reviewer">reviewer</option>
        <option value="decomposer">decomposer</option>
        <option value="domain-specialist">domain-specialist</option>
      </select>
      <select
        value={status}
        onChange={e => setStatus(e.target.value)}
        style={{ padding: '0.3rem 0.5rem', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 4 }}
      >
        <option value="">all statuses</option>
        <option value="mutable">mutable</option>
        <option value="guarded">guarded</option>
        <option value="frozen">frozen</option>
      </select>
      <button
        type="button"
        onClick={apply}
        style={{
          padding: '0.3rem 0.8rem', fontSize: 13, fontWeight: 500,
          background: '#1a1a1a', color: '#fff',
          border: 'none', borderRadius: 4, cursor: 'pointer',
        }}
      >
        Apply
      </button>
      {(initialRole || initialStatus) && (
        <button
          type="button"
          onClick={clear}
          style={{
            padding: '0.3rem 0.6rem', fontSize: 13, fontWeight: 500,
            background: '#fff', color: '#666',
            border: '1px solid #d1d5db', borderRadius: 4, cursor: 'pointer',
          }}
        >
          Clear
        </button>
      )}
    </div>
  );
}
