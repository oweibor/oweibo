// GET /api/platform/prompts/runs — recent GEPA optimizer runs (C.8).

import { type NextRequest, NextResponse } from 'next/server';
import { requireScope } from '@/lib/auth';
import { pipelineApi } from '@/lib/api';

export async function GET(req: NextRequest) {
  try {
    await requireScope('platform:admin');
    const limit = req.nextUrl.searchParams.get('limit') ?? '14';
    const result = await pipelineApi.get<{ runs: unknown[] }>(
      `/platform/prompts/runs?limit=${encodeURIComponent(limit)}`,
    );
    return NextResponse.json(result);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: String(err) }, { status });
  }
}
