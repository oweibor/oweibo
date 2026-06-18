/**
 * T.5.c: server-component badge that surfaces the tenant's calibration
 * score in the top bar of every /t/[tenantId]/* page. Reads
 * GET /api/v1/tenants/:tenantId/calibration on the pipeline service
 * (F.4.6) and renders a small colored chip plus a tooltip-style
 * description.
 *
 * F.4.8: links to the calibration detail page when one is available,
 * onboarding otherwise.
 *
 * Degrades gracefully: if the endpoint errors (pipeline unreachable,
 * pre-T.0 tenant, etc.) the badge renders a muted '—' chip instead of
 * crashing the layout.
 */
import Link from 'next/link';
import { pipelineApi } from '@/lib/api';

interface CalibrationResponse {
  tenantId: string;
  score: number;
  threshold: number;
  summary: string;
  signals: Record<string, number | boolean>;
  gateEnabled: boolean;
  meetsAutonomousThreshold: boolean;
}

interface CalibrationBadgeProps {
  tenantId: string;
}

function chipColor(score: number): { bg: string; fg: string } {
  if (score < 0.20) return { bg: '#525252', fg: '#fff' };
  if (score < 0.40) return { bg: '#7c2d12', fg: '#fff' };
  if (score < 0.60) return { bg: '#92400e', fg: '#fff' };
  if (score < 0.85) return { bg: '#1e3a8a', fg: '#fff' };
  return { bg: '#065f46', fg: '#fff' };
}

export async function CalibrationBadge({ tenantId }: CalibrationBadgeProps) {
  let calibration: CalibrationResponse | null = null;
  try {
    calibration = await pipelineApi.get<CalibrationResponse>(`/tenants/${tenantId}/calibration`);
  } catch {
    calibration = null;
  }

  if (!calibration) {
    return (
      <Link
        href={`/t/${tenantId}/calibration`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
          padding: '2px 8px', background: '#374151', color: '#fff',
          fontSize: 11, borderRadius: 3, textDecoration: 'none',
        }}
        title="Calibration unavailable"
      >
        <span style={{ fontFamily: 'monospace' }}>—</span>
        <span>Calibration</span>
      </Link>
    );
  }

  const { bg, fg } = chipColor(calibration.score);
  const pct = (calibration.score * 100).toFixed(0);

  return (
    <Link
      href={`/t/${tenantId}/calibration`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
        padding: '2px 8px', background: bg, color: fg,
        fontSize: 11, borderRadius: 3, textDecoration: 'none',
        whiteSpace: 'nowrap',
      }}
      title={`${calibration.summary} (score ${calibration.score.toFixed(2)} / threshold ${calibration.threshold.toFixed(2)}${calibration.gateEnabled ? ', gate on' : ', gate off'})`}
    >
      <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{pct}%</span>
      <span>Calibration</span>
      {calibration.gateEnabled && !calibration.meetsAutonomousThreshold && (
        <span style={{ fontSize: 10, opacity: 0.85 }}>· locked</span>
      )}
    </Link>
  );
}
