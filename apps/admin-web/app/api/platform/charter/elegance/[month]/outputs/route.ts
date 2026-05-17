// GET /api/platform/charter/elegance/[month]/outputs
// Returns task outputs (generated or synthetic) for the reviewer UI.

import { type NextRequest, NextResponse } from 'next/server';
import { requireScope } from '@/lib/auth';
import { pipelineApi } from '@/lib/api';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ month: string }> },
) {
  try {
    await requireScope('platform:charter:read');
    const { month } = await params;
    const data = await pipelineApi.get<{ tasks: unknown[] }>(
      `/charter/elegance/${month}/outputs`,
    );
    return NextResponse.json(data);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: String(err) }, { status });
  }
}
