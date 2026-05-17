// GET  /api/platform/operational-mode — current state + transition history
// POST /api/platform/operational-mode — change mode (platform:admin only)

import { type NextRequest, NextResponse } from 'next/server';
import { requireScope, getSessionUser } from '@/lib/auth';
import { pipelineApi } from '@/lib/api';

export async function GET() {
  try {
    await requireScope('platform:admin');
    const result = await pipelineApi.get<{ state: unknown; history: unknown[] }>(
      '/platform/operational-mode',
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
    const body = await req.json() as { mode: number; reason: string; autoTrigger?: string };

    const result = await pipelineApi.post<{ ok: boolean; mode: number }>(
      '/platform/operational-mode',
      {
        mode:        body.mode,
        reason:      body.reason,
        setBy:       user?.user_id ?? 'unknown',
        autoTrigger: body.autoTrigger ?? null,
      },
    );

    return NextResponse.json(result);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: String(err) }, { status });
  }
}
