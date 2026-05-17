// GET /api/platform/cohorts/channels — available channel names (D.1).

import { NextResponse } from 'next/server';
import { requireScope } from '@/lib/auth';
import { pipelineApi } from '@/lib/api';

export async function GET() {
  try {
    await requireScope('platform:admin');
    const result = await pipelineApi.get<{ channels: string[] }>('/platform/cohorts/channels');
    return NextResponse.json(result);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: String(err) }, { status });
  }
}
