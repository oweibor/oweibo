// GET  /api/platform/prompts/mutations — list slots with current mutation_status (D.12).
// POST /api/platform/prompts/mutations — change mutation_status (platform:admin).

import { type NextRequest, NextResponse } from 'next/server';
import { requireScope } from '@/lib/auth';
import { pipelineApi } from '@/lib/api';

export async function GET(req: NextRequest) {
  try {
    await requireScope('platform:admin');
    const role   = req.nextUrl.searchParams.get('role');
    const status = req.nextUrl.searchParams.get('status');
    const query = new URLSearchParams();
    if (role)   query.set('role', role);
    if (status) query.set('status', status);
    const qs = query.toString();
    const path = qs ? `/platform/prompts/mutations?${qs}` : '/platform/prompts/mutations';
    const result = await pipelineApi.get<{ slots: unknown[] }>(path);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: String(err) }, { status });
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireScope('platform:admin');
    const body = await req.json();
    const result = await pipelineApi.post<unknown>(
      '/platform/prompts/mutations',
      body,
    );
    return NextResponse.json(result);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: String(err) }, { status });
  }
}
