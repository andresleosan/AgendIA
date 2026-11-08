import { NextResponse } from 'next/server';
import { requireSuperadmin } from '@/lib/server/auth';
import { getBusiness } from '@/lib/server/businesses';
import { bookingDataPolicyInputSchema, readBookingDataPolicy, saveBookingDataPolicy } from '@/lib/server/booking-data-policy';
import { adminBookingPolicyInputSchema, executeAdminBookingPolicy } from '@/lib/server/booking-policy-commands';
import { BOOKING_ADMISSION_RELEASE } from '@/lib/booking-admission-release';
import { documentIdSchema } from '@/lib/server/schemas';
import { apiError, HttpError, readJson } from '@/lib/server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };
export async function GET(request: Request) {
  try {
    await requireSuperadmin(request); const query = new URL(request.url).searchParams;
    if ([...query.keys()].some(key => key !== 'businessId') || query.getAll('businessId').length !== 1) throw new HttpError(400, 'Consulta inválida.');
    const id = documentIdSchema.parse(query.get('businessId')); await getBusiness(id);
    return NextResponse.json(await readBookingDataPolicy(id), { headers });
  } catch (error) { return apiError(error); }
}
export async function PATCH(request: Request) {
  try {
    const user = await requireSuperadmin(request);
    if (new URL(request.url).search) throw new HttpError(400, 'Consulta inválida.');
    if (BOOKING_ADMISSION_RELEASE === 'enforce') {
      const input = await readJson(request, adminBookingPolicyInputSchema, 4096);
      const result = await executeAdminBookingPolicy(user, input);
      return NextResponse.json(result, { status: result.outcome === 'pending' ? 202 : 200, headers });
    }
    const input = await readJson(request, bookingDataPolicyInputSchema, 8192), policy = await saveBookingDataPolicy(user, input);
    return NextResponse.json({ policy, capability: { configured: true, revision: policy.revision, dataMode: policy.dataMode, representedMinorsEnabled: policy.representedMinorsEnabled } }, { headers });
  } catch (error) { return apiError(error); }
}
