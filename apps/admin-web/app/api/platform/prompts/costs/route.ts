// GET /api/platform/prompts/costs — daily GEPA cost burn-down (C.8).

import { type NextRequest, NextResponse } from 'next/server';
import { requireScope } from '@/lib/auth';
import { pipelineApi } from '@/lib/api';

export async function GET(req: NextRequest) {
  try {
    await requireScope('platform:admin');
    const days = req.nextUrl.searchParams.get('days') ?? '14';
    const result = await pipelineApi.get<{ series: unknown[]; days: number }>(
      `/platform/prompts/costs?days=${encodeURIComponent(days)}`,
    );
    return NextResponse.json(result);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: String(err) }, { status });
  }
}
