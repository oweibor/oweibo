// POST /api/platform/cohorts/tenants/[tenantId] — change a tenant's cohort (D.1).

import { type NextRequest, NextResponse } from 'next/server';
import { requireScope } from '@/lib/auth';
import { pipelineApi } from '@/lib/api';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> },
) {
  try {
    await requireScope('platform:admin');
    const { tenantId } = await params;
    const body = await req.json();
    const result = await pipelineApi.post<unknown>(
      `/platform/cohorts/tenants/${encodeURIComponent(tenantId)}`,
      body,
    );
    return NextResponse.json(result);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: String(err) }, { status });
  }
}
