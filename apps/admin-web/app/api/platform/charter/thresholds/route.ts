// GET  /api/platform/charter/thresholds — current drift threshold config
// POST /api/platform/charter/thresholds — update thresholds (platform:admin)

import { type NextRequest, NextResponse } from 'next/server';
import { requireScope, getSessionUser } from '@/lib/auth';
import { pipelineApi } from '@/lib/api';

export async function GET() {
  try {
    await requireScope('platform:charter:read');
    const result = await pipelineApi.get<Record<string, unknown>>(
      '/platform/charter/thresholds',
    );
    return NextResponse.json(result);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: String(err) }, { status });
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireScope('platform:admin');
    const user = await getSessionUser();
    const body = await req.json() as {
      threshold_7d:    number;
      threshold_30d:   number;
      threshold_90d:   number;
      threshold_vs_v0: number;
      reason:          string;
    };

    const result = await pipelineApi.post<{ ok: boolean }>(
      '/platform/charter/thresholds',
      { ...body, changedBy: user?.user_id ?? 'unknown' },
    );

    return NextResponse.json(result);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: String(err) }, { status });
  }
}
