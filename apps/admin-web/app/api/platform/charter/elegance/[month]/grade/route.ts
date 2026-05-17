// POST /api/platform/charter/elegance/[month]/grade
// Submits a reviewer grade for one task. Triggers auto-escalation check.

import { type NextRequest, NextResponse } from 'next/server';
import { requireScope, getSessionUser } from '@/lib/auth';
import { pipelineApi } from '@/lib/api';

export async function POST(
  req: NextRequest,
  { params }: { params: { month: string } },
) {
  try {
    await requireScope('platform:charter:write');
    const user = await getSessionUser();
    const body = await req.json() as Record<string, unknown>;

    const result = await pipelineApi.post<{ escalated: boolean; reasons: string[] }>(
      `/charter/elegance/${params.month}/grade`,
      { ...body, reviewerId: user?.user_id ?? 'unknown' },
    );

    return NextResponse.json(result);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: String(err) }, { status });
  }
}
