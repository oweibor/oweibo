// GET /api/platform/prompts/mutations/[slot]/[role] — full status-change history.

import { type NextRequest, NextResponse } from 'next/server';
import { requireScope } from '@/lib/auth';
import { pipelineApi } from '@/lib/api';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slot: string; role: string }> },
) {
  try {
    await requireScope('platform:admin');
    const { slot, role } = await params;
    const limit = req.nextUrl.searchParams.get('limit') ?? '50';
    const result = await pipelineApi.get<{ history: unknown[] }>(
      `/platform/prompts/mutations/${encodeURIComponent(slot)}/${encodeURIComponent(role)}?limit=${encodeURIComponent(limit)}`,
    );
    return NextResponse.json(result);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: String(err) }, { status });
  }
}
