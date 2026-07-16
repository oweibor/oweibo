'use client';

import { useState } from 'react';
import type { PendingPromotion } from './page';

interface Props {
  promotion: PendingPromotion;
}

export function PromotionDecisionControls({ promotion }: Props) {
  const [reason, setReason]         = useState('');
  const [submitting, setSubmitting] = useState<'approved' | 'rejected' | null>(null);
  const [error, setError]           = useState<string | null>(null);

  const canApprove = promotion.gateResult.allowed;
  const reasonOK   = reason.trim().length >= 3;

  async function submit(decision: 'approved' | 'rejected') {
    if (!reasonOK) return;
    if (decision === 'approved') {
      const ok = window.confirm(
        `Approve promotion of ${promotion.role}/${promotion.slotId} to ${promotion.toChannel}? ` +
        `This is irreversible and immediately affects every tenant on the channel.`,
      );
      if (!ok) return;
    }
    setSubmitting(decision);
    setError(null);
    try {
      const res = await fetch('/api/platform/promotions/decide', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          armId:       promotion.armId,
          slotId:      promotion.slotId,
          role:        promotion.role,
          promptHash:  promotion.promptHash,
          fromChannel: promotion.fromChannel,
          toChannel:   promotion.toChannel,
          decision,
          reason:      reason.trim(),
        }),
      });
      const data = await res.json() as { error?: string; message?: string };
      if (!res.ok) {
        setError(data.message ?? data.error ?? `HTTP ${res.status}`);
        setSubmitting(null);
        return;
      }
      window.location.reload();
    } catch (err: unknown) {
      setError(String(err));
      setSubmitting(null);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
      <textarea
        value={reason}
        onChange={e => setReason(e.target.value)}
        placeholder="Reason for this decision (audited)"
        rows={2}
        disabled={submitting !== null}
        style={{
          width: '100%', padding: '0.4rem 0.6rem', fontSize: 13,
          border: '1px solid #d1d5db', borderRadius: 4, resize: 'vertical',
          boxSizing: 'border-box',
        }}
      />
      {error && <p style={{ color: '#c00', fontSize: 12, margin: 0 }}>{error}</p>}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button
          type="button"
          onClick={() => submit('approved')}
          disabled={!canApprove || !reasonOK || submitting !== null}
          title={canApprove ? '' : 'Approval blocked — non-human gate checks still failing'}
          style={{
            padding: '0.4rem 1rem', fontSize: 13, fontWeight: 600,
            background: !canApprove || !reasonOK ? '#e5e7eb' : '#16a34a',
            color:      !canApprove || !reasonOK ? '#9ca3af' : '#fff',
            border: 'none', borderRadius: 4,
            cursor:     !canApprove || !reasonOK ? 'not-allowed' : 'pointer',
          }}
        >
          {submitting === 'approved' ? 'Approving…' : 'Approve & promote'}
        </button>
        <button
          type="button"
          onClick={() => submit('rejected')}
          disabled={!reasonOK || submitting !== null}
          style={{
            padding: '0.4rem 1rem', fontSize: 13, fontWeight: 600,
            background: !reasonOK ? '#e5e7eb' : '#fff',
            color:      !reasonOK ? '#9ca3af' : '#991b1b',
            border:     !reasonOK ? '1px solid #d1d5db' : '1px solid #fca5a5',
            borderRadius: 4,
            cursor:     !reasonOK ? 'not-allowed' : 'pointer',
          }}
        >
          {submitting === 'rejected' ? 'Rejecting…' : 'Reject'}
        </button>
      </div>
    </div>
  );
}
