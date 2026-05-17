// POST /api/platform/promotions/decide — approve or reject a promotion (D.6).
// Requires platform:admin scope. Proxies to core-engine which writes the
// audit row and (on approve) flips the channel pointer.

import { type NextRequest, NextResponse } from 'next/server';
import { requireScope } from '@/lib/auth';
import { pipelineApi } from '@/lib/api';

export async function POST(req: NextRequest) {
  try {
    await requireScope('platform:admin');
    const body = await req.json();
    const result = await pipelineApi.post<unknown>(
      '/platform/promotions/decide',
      body,
    );
    return NextResponse.json(result);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: String(err) }, { status });
  }
}
