import { NextResponse } from 'next/server';
import { requireSuperadmin } from '@/lib/server/auth';
import { apiError, HttpError, readJson } from '@/lib/server/http';
import { listResponseQuotaReviews, reconcileResponseQuota, quotaReconcileSchema } from '@/lib/server/response-quota-admin';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };
export async function GET(request: Request) {
  try {
    const actor = await requireSuperadmin(request), query = new URL(request.url).searchParams;
    if ([...query.keys()].some(key => key !== 'after') || query.getAll('after').length > 1) throw new HttpError(400, 'Consulta inválida.');
    return NextResponse.json(await listResponseQuotaReviews(actor, query.has('after') ? query.get('after')! : undefined), { headers });
  } catch (error) { return apiError(error); }
}
export async function PATCH(request: Request) {
  try { const actor = await requireSuperadmin(request); if (new URL(request.url).search) throw new HttpError(400, 'Consulta inválida.'); return NextResponse.json(await reconcileResponseQuota(actor, await readJson(request, quotaReconcileSchema, 4096)), { headers }); }
  catch (error) { return apiError(error); }
}
