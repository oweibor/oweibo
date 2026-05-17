// GET /api/platform/prompts/frontier/[slot]/[role] — all candidates for one slot+role (C.8).

import { type NextRequest, NextResponse } from 'next/server';
import { requireScope } from '@/lib/auth';
import { pipelineApi } from '@/lib/api';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slot: string; role: string }> },
) {
  try {
    await requireScope('platform:admin');
    const { slot, role } = await params;
    const result = await pipelineApi.get<unknown>(
      `/platform/prompts/frontier/${encodeURIComponent(slot)}/${encodeURIComponent(role)}`,
    );
    return NextResponse.json(result);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: String(err) }, { status });
  }
}
