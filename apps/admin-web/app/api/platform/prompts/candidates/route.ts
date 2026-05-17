// GET /api/platform/prompts/candidates — recent prompt_versions (C.8).

import { type NextRequest, NextResponse } from 'next/server';
import { requireScope } from '@/lib/auth';
import { pipelineApi } from '@/lib/api';

export async function GET(req: NextRequest) {
  try {
    await requireScope('platform:admin');
    const role  = req.nextUrl.searchParams.get('role');
    const slot  = req.nextUrl.searchParams.get('slot');
    const limit = req.nextUrl.searchParams.get('limit') ?? '50';
    const qs = new URLSearchParams();
    if (role)  qs.set('role', role);
    if (slot)  qs.set('slot', slot);
    qs.set('limit', limit);
    const result = await pipelineApi.get<{ candidates: unknown[] }>(
      `/platform/prompts/candidates?${qs.toString()}`,
    );
    return NextResponse.json(result);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: String(err) }, { status });
  }
}
